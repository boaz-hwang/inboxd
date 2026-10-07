"""One model's frozen prefix before gradient tracing; original full-target loss."""
class OutsideGradientPrefix:
    def __init__(self,model,nn,*,prefix_count=28,suffix_count=4):
        import mlx.core as mx
        from mlx.utils import tree_flatten
        from mlx_lm.models.base import create_attention_mask,create_ssm_mask
        self.mx=mx;self.nn=nn;self.flatten=tree_flatten;self.model=model
        self.core=getattr(model,'language_model',model).model
        self.layers=list(model.layers);self.prefix_count=prefix_count
        if len(self.layers)!=prefix_count+suffix_count or len({id(x)for x in self.layers})!=len(self.layers):
            raise ValueError('outside_prefix_layer_layout_changed')
        prefix=self.layers[:prefix_count];suffix=self.layers[prefix_count:]
        if any(tree_flatten(x.trainable_parameters())for x in prefix):
            raise ValueError('outside_prefix_trainable')
        if not all(tree_flatten(x.trainable_parameters())for x in suffix):
            raise ValueError('outside_suffix_not_trainable')
        suffix_arrays={id(a)for x in suffix for _,a in tree_flatten(x.trainable_parameters())}
        global_arrays={id(a)for _,a in tree_flatten(model.trainable_parameters())}
        if not global_arrays or global_arrays!=suffix_arrays or tree_flatten(self.core.embed_tokens.trainable_parameters()):
            raise ValueError('outside_trainable_outside_suffix')
        self.attention_mask=create_attention_mask;self.ssm_mask=create_ssm_mask
        self.active=None;self.prefix_preparations=0;self.suffix_forwards=0
        self.core_type=type(self.core);self.original_call=self.core_type.__call__
        self.original_factory=nn.value_and_grad
        self.metadata={'frozen_prefix_layers':prefix_count,'trainable_suffix_layers':suffix_count,
            'trainable_parameter_arrays':len(global_arrays),'embedding_trainable_arrays':0,
            'all_trainable_arrays_in_suffix':True,'prefix_training_mode_preserved':True,
            'original_checkpointed_loss_reused':True,'scope':'exact_model_gradient_call_only'}
        owner=self
        def core_call(core,inputs,cache=None,input_embeddings=None):
            if core is not owner.core or owner.active is None:
                return owner.original_call(core,inputs,cache=cache,input_embeddings=input_embeddings)
            if cache is not None or input_embeddings is not None:
                raise ValueError('outside_prefix_cached_or_external_embeddings')
            original_inputs,hidden,fa_mask,ssm_mask=owner.active
            if inputs.shape!=original_inputs.shape or not bool(mx.array_equal(inputs,original_inputs).item()):
                raise ValueError('outside_prefix_input_changed')
            for layer in owner.layers[prefix_count:]:
                hidden=layer(hidden,mask=ssm_mask if layer.is_linear else fa_mask,cache=None)
            owner.suffix_forwards+=1
            return core.norm(hidden)
        def factory(*args,**kwargs):
            original=owner.original_factory(*args,**kwargs)
            if not args or args[0] is not model:return original
            def differentiated(*arguments,**keywords):
                if len(arguments)!=3 or arguments[0] is not model or keywords or owner.active is not None:
                    raise ValueError('outside_prefix_gradient_call_changed')
                # Prefix computation finishes before entering original value_and_grad.
                owner.active=owner.prepare(arguments[1])
                try:return original(*arguments,**keywords)
                finally:owner.active=None
            return differentiated
        self.core_type.__call__=core_call
        nn.value_and_grad=factory

    def prepare(self,batch):
        if any(self.flatten(x.trainable_parameters())for x in self.layers[:self.prefix_count]):
            raise ValueError('outside_prefix_became_trainable')
        if self.flatten(self.core.embed_tokens.trainable_parameters()):
            raise ValueError('outside_embedding_became_trainable')
        if any(not x.training for x in self.layers):
            raise ValueError('outside_prefix_training_mode_changed')
        inputs=batch[:,:-1];hidden=self.core.embed_tokens(inputs)
        fa_mask=self.attention_mask(hidden,None);ssm_mask=self.ssm_mask(hidden,None)
        for layer in self.layers[:self.prefix_count]:
            hidden=layer(hidden,mask=ssm_mask if layer.is_linear else fa_mask,cache=None)
            self.mx.eval(hidden)
        self.prefix_preparations+=1
        return inputs,hidden,fa_mask,ssm_mask

    def restore(self):
        self.active=None
        self.nn.value_and_grad=self.original_factory
        self.core_type.__call__=self.original_call
