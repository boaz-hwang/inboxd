# Portions adapted from Hugging Face Transformers v5.13.0:
# Copyright 2025 The Qwen Team and The HuggingFace Inc. team. All rights reserved.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# Source: https://github.com/huggingface/transformers/blob/v5.13.0/src/transformers/models/qwen3_5/modeling_qwen3_5.py#L227-L300
"""Draft scalar-gate chunk matrix recurrence, matching HF's UT transform.

Q/k arrive already normalized and query-scaled by installed Qwen3.5.
Unlike HF's public function, this function MUST NOT normalize/scale them again.
The state convention here is MLX [B,H,Dv,Dk], transposed only internally.
Algebraically full-context differentiable; floating point reassociation differs.
No custom VJP, stop_gradient, leaf copies, new compile, or explicit eval.

Reference: Transformers v5.13.0 modeling_qwen3_5.py:227-300 (Apache-2.0).
The lower-unitriangular inverse uses basic differentiable matrix operations;
MLX0.32.2's CPU-only/no-VJP tri_inv is intentionally not used.
"""
import mlx.core as mx
import mlx.nn as nn

VERSION = 'parallel-scalar-log-gate-chunk32-draft-v1'


def log_gate(A_log, a, dt_bias):
    """Preserve installed compute_g's exact expression before its outer exp."""
    return -mx.exp(A_log.astype(mx.float32))*nn.softplus(a+dt_bias)


def _unit_lower_inverse(negative_lower):
    """Inverse of I-negative_lower, using row forward substitution.

    HF's original loop stores strictly lower inverse rows then adds I.
    Here rows contain I from construction, so raw_row @ previous_rows is
    exactly raw_row + raw_row @ previous_strict_lower in real arithmetic.
    No in-place update of a matrix used by earlier gradient operations.
    """
    size=negative_lower.shape[-1]
    prefix=negative_lower.shape[:-2]
    rows=[]
    for index in range(size):
        if index:
            previous=mx.stack(rows,axis=-2)[...,:index]
            raw=negative_lower[...,index:index+1,:index]
            lower=(raw @ previous).squeeze(-2)
        else:
            lower=mx.zeros(prefix+(0,),dtype=mx.float32)
        rows.append(mx.concatenate((lower,mx.ones(prefix+(1,),dtype=mx.float32),
            mx.zeros(prefix+(size-index-1,),dtype=mx.float32)),axis=-1))
    return mx.stack(rows,axis=-2)


def parallel_chunk_gated_delta_ops(q,k,v,log_g,beta,state=None,mask=None,*,chunk_size=32):
    if type(chunk_size) is not int or chunk_size<1:
        raise ValueError('invalid_parallel_chunk_size')
    if mask is not None:
        raise ValueError('parallel_chunk_mask_unsupported')
    batch,length,key_heads,key_dim=q.shape
    value_heads,value_dim=v.shape[-2:]
    if length<1 or key_heads<1 or value_heads%key_heads:
        raise ValueError('invalid_parallel_recurrence_shape')
    if k.shape!=q.shape or v.shape[:2]!=(batch,length):
        raise ValueError('invalid_parallel_qkv_shape')
    if log_g.shape!=(batch,length,value_heads):
        raise ValueError('parallel_chunk_requires_scalar_log_gate')
    if beta.shape!=(batch,length,value_heads):
        raise ValueError('invalid_parallel_beta_shape')
    supported=(mx.float16,mx.bfloat16,mx.float32)
    if any(x.dtype not in supported for x in (q,k,v,log_g,beta)):
        raise ValueError('parallel_chunk_dtype_unsupported')
    if state is None:
        state=mx.zeros((batch,value_heads,value_dim,key_dim),dtype=mx.float32)
    if state.shape!=(batch,value_heads,value_dim,key_dim) or state.dtype!=mx.float32:
        raise ValueError('parallel_chunk_requires_float32_state')
    output_dtype=q.dtype
    if value_heads!=key_heads:
        q=mx.repeat(q,value_heads//key_heads,axis=-2)
        k=mx.repeat(k,value_heads//key_heads,axis=-2)
    # Only layout/dtype conversion; no additional scale or normalization.
    q,k,v=[x.transpose(0,2,1,3).astype(mx.float32)for x in(q,k,v)]
    log_g,beta=[x.transpose(0,2,1).astype(mx.float32)for x in(log_g,beta)]
    padding=(-length)%chunk_size
    if padding:
        q,k,v=[mx.pad(x,[(0,0),(0,0),(0,padding),(0,0)])for x in(q,k,v)]
        # log gate0 and beta0 preserve the state on synthetic tail positions.
        log_g,beta=[mx.pad(x,[(0,0),(0,0),(0,padding)])for x in(log_g,beta)]
    count=(length+padding)//chunk_size
    q,k,v=[x.reshape(batch,value_heads,count,chunk_size,x.shape[-1])for x in(q,k,v)]
    beta=beta.reshape(batch,value_heads,count,chunk_size)
    log_g=log_g.reshape(batch,value_heads,count,chunk_size)
    cumulative=mx.cumsum(log_g,axis=-1)
    lower=mx.tril(mx.ones((chunk_size,chunk_size),dtype=mx.bool_))
    # Mask BEFORE exp: unused upper entries must not overflow then create NaN
    # in backward through 0*inf. This matches HF's tril-before-exp convention.
    differences=cumulative[..., :,None]-cumulative[...,None,:]
    decay=mx.exp(mx.where(lower,differences,0))*lower
    kb=k*beta[...,None]
    vb=v*beta[...,None]
    negative_lower=mx.tril(-(kb @ k.swapaxes(-1,-2))*decay,k=-1)
    inverse=_unit_lower_inverse(negative_lower)
    new_values=inverse @ vb
    decayed_keys=inverse @ (kb*mx.exp(cumulative)[...,None])
    current=state.swapaxes(-1,-2)
    outputs=[]
    for index in range(count):
        qi,ki,ui,wi=[x[:,:,index]for x in(q,k,new_values,decayed_keys)]
        ci=cumulative[:,:,index]
        correction=ui-wi @ current
        within=(qi @ ki.swapaxes(-1,-2))*decay[:,:,index]
        outputs.append((qi*mx.exp(ci)[...,None]) @ current + within @ correction)
        relative=mx.exp(ci[...,-1,None]-ci)
        current=current*mx.exp(ci[...,-1,None,None]) + (
            ki*relative[...,None]).swapaxes(-1,-2) @ correction
    output=mx.stack(outputs,axis=2).reshape(batch,value_heads,length+padding,value_dim)
    output=output[:,:,:length].transpose(0,2,1,3).astype(output_dtype)
    return output,current.swapaxes(-1,-2)


class ParallelChunkPatch:
    """Only installed Qwen3.5's bound update reference, use_kernel=False path."""
    def __init__(self,chunk_size=32,unsupported='error'):
        if unsupported not in ('error','reference'):
            raise ValueError('invalid_parallel_unsupported_policy')
        self.chunk_size,self.unsupported=chunk_size,unsupported
        self.original=None
        self.stats=dict(parallel_calls=0,reference_inference_calls=0,reference_unsupported_calls=0)

    def install(self):
        from mlx_lm.models import qwen3_5
        if self.original is not None:
            raise RuntimeError('parallel_chunk_already_installed')
        self.original=qwen3_5.gated_delta_update
        def update(q,k,v,a,b,A_log,dt_bias,state=None,mask=None,use_kernel=True):
            if use_kernel:
                self.stats['reference_inference_calls']+=1
                return self.original(q,k,v,a,b,A_log,dt_bias,state,mask,use_kernel=use_kernel)
            # The actual opt-in scope is no-cache/scalar-gate training.
            if state is not None or mask is not None or a.ndim!=3:
                if self.unsupported=='reference':
                    self.stats['reference_unsupported_calls']+=1
                    return self.original(q,k,v,a,b,A_log,dt_bias,state,mask,use_kernel=use_kernel)
                raise ValueError('parallel_chunk_training_scope_unsupported')
            self.stats['parallel_calls']+=1
            return parallel_chunk_gated_delta_ops(q,k,v,log_gate(A_log,a,dt_bias),
                mx.sigmoid(b),chunk_size=self.chunk_size)
        self.replacement=update
        qwen3_5.gated_delta_update=update
        return self

    def snapshot_stats(self,reset=False):
        result=dict(self.stats,version=VERSION,chunk_size=self.chunk_size,
            unsupported_policy=self.unsupported,query_scale='already_applied_upstream',
            state_layout='MLX_Dv_Dk',gate='direct_log_expression')
        if reset:self.stats={key:0 for key in self.stats}
        return result

    def restore(self):
        from mlx_lm.models import qwen3_5
        if self.original is not None:
            if qwen3_5.gated_delta_update is not self.replacement:
                raise RuntimeError('parallel_chunk_patch_ownership_changed')
            qwen3_5.gated_delta_update=self.original
            self.original=None


def install_parallel_chunk(chunk_size=32,unsupported='error'):
    return ParallelChunkPatch(chunk_size,unsupported).install()
