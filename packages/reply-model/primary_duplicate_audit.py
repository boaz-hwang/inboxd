"""Bounded target-free RAM comparison. Scores are retrieval diagnostics, not gates."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from behavior_audit import read,write_private,digest,client,recover,serve


def normalized_context(record):
    text='\n'.join(str(m.get('author_role'))+' '+str(m.get('body') or '') for m in record['context'])
    return ''.join(c for c in unicodedata.normalize('NFKC',text).casefold() if c.isalnum())


def shingles(text):
    return {text[i:i+3] for i in range(max(0,len(text)-2))}


def compare(candidates, prior):
    reference={identity:normalized_context(record) for identity,record in prior.items()}
    features={identity:shingles(text) for identity,text in reference.items()}
    exact_index={}
    for identity,text in reference.items():
        exact_index.setdefault(hashlib.sha256(text.encode()).hexdigest(),[]).append(identity)
    rows=[]
    for identity,record in candidates.items():
        text=normalized_context(record);feature=shingles(text);sha=hashlib.sha256(text.encode()).hexdigest()
        ranked=[]
        for old, oldfeatures in features.items():
            shared=len(feature & oldfeatures);union=len(feature | oldfeatures)
            ranked.append({'prior_id':old,'character_trigram_jaccard':shared/union if union else 0,
                           'shared_character_trigrams':shared,'candidate_character_trigrams':len(feature),
                           'prior_character_trigrams':len(oldfeatures),'length_ratio':min(len(text),len(reference[old]))/max(len(text),len(reference[old]),1)})
        ranked.sort(key=lambda r:(-r['character_trigram_jaccard'],r['prior_id']))
        rows.append({'id':identity,'input_hash':digest(record['messages']),'normalized_context_sha256':sha,
                     'normalized_exact_prior_matches':exact_index.get(sha,[]),'compared_prior_inputs':len(prior),
                     'top_three_near_retrieval_pairs':ranked[:3],
                     'semantic_duplicate_status':'pending_ranked_pair_agent_review_not_whole_corpus_semantic_comparison'})
    return rows


def main():
    base=Path.home()/'.inboxd/reply-model';root=base/'evaluations/fresh-expansion-20261006-v1';output=root/'historical-comparison-owner';output.mkdir(mode=0o700,exist_ok=True)
    records,tokens,metadata,train,quality=recover(base/'learning/granite-fullpool-20261006-v1',output,include_tokens=False)
    grant=read(root/'primary-owner/owner-grant.json');candidates={}
    for offset in range(0,len(grant['quality_context_ids']),20):
        for item in client(grant,{'op':'records','ids':grant['quality_context_ids'][offset:offset+20]})['cases']:
            candidates[item['record']['id']]=item['record']
    rows=compare(candidates,records)
    packet={'schema':'bounded-prior-context-duplicate-audit-v1','cases':rows,'candidate_count':len(candidates),
            'prior_input_count':len(records),'normalized_exact_matching_candidates':sum(bool(r['normalized_exact_prior_matches']) for r in rows),
            'compared_contexts':'Original source-bound 1374 historical training +60 valid/test target-free contexts recovered with five exact hashes each; original targets hidden from reviewers.',
            'prior_source_use_manifest':str(root/'actual-model-used-source-manifest-v4.json'),
            'limitations':['88 older model-use source-metadata gaps and reviewed-only context corpora are not recovered or claimed compared.',
                           'Three-character Jaccard is a deterministic lexical retrieval score, not semantic similarity judgment.',
                           'Top three per candidate permit bounded semantic pair review; no global semantic duplicate-zero claim.',
                           'No quality/admission threshold is invented from similarity scores.'],
            'bodies_persisted':0,'token_arrays_persisted':0,'historical_targets_used_as_gold':False}
    packet['audit_hash']=digest(packet);write_private(root/'bounded-prior-context-duplicate-audit.json',packet)
    candidates.clear()
    print(json.dumps({'phase':'near_audit_complete','candidates':len(rows),'prior_inputs':len(records),'normalized_exact_matching_candidates':packet['normalized_exact_matching_candidates']}),flush=True)
    # Keep exact source contexts solely for the authorized top-pair audit.
    serve(records,{},metadata,set(),set(records),output)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'phase':'failed','error_type':type(error).__name__,'bodies_logged':False}),flush=True)
        raise SystemExit(1)
