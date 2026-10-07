"""Private full-episode text overlap audit; outputs source-free counts/hashes only.

Short target-only greetings are not leakage evidence. Text similarity is a
conservative audit, not proof of semantic independence or paraphrase detection.
"""
import unicodedata
import history


def normalized(text):
    return ' '.join(unicodedata.normalize('NFKC',text).casefold().split())


def episode_text(record):
    context=[f"{message.get('author_role','unknown')}: {normalized(message['body'])}"
             for message in record.get('context',[])]
    targets=['self: '+normalized(message['body']) for message in record.get('targets',[])]
    return '\n'.join(context+['<target>']+targets)


def grams(text):
    return {text[i:i+3] for i in range(max(0,len(text)-2))}


def cross_split_audit(training_validation,evaluation,*,near_threshold=.9,min_near_chars=200):
    """Never expose bodies; lower-priority cross-split candidates are returned by ID."""
    exact,near,sources,shared_long_messages=[],[],[],[]
    comparisons=[]
    eval_data=[]
    for record in evaluation:
        text=episode_text(record)
        eval_data.append((record,text,grams(text),set(record.get('source_message_keys',[])),
            {normalized(message['body']) for message in record.get('context',[])+record.get('targets',[])
             if len(normalized(message['body']))>=80}))
    for record in training_validation:
        text=episode_text(record);token_grams=grams(text)
        keys=set(record.get('source_message_keys',[]))
        messages={normalized(message['body']) for message in record.get('context',[])+record.get('targets',[])
                  if len(normalized(message['body']))>=80}
        for other,other_text,other_grams,other_keys,other_messages in eval_data:
            pair={'candidate_id':record['id'],'evaluation_id_hash':history.digest(other['id'])}
            if keys & other_keys:sources.append(pair)
            if text==other_text:exact.append(pair)
            elif min(len(text),len(other_text))>=min_near_chars:
                union=token_grams|other_grams
                score=len(token_grams&other_grams)/len(union) if union else 0
                if score>=near_threshold:near.append({**pair,'similarity':round(score,6)})
            if messages&other_messages:shared_long_messages.append({**pair,'shared_message_count':len(messages&other_messages)})
            comparisons.append([history.digest(text),history.digest(other_text)])
    result={'normalized_full_episode_exact_pairs':exact,'long_episode_near_pairs':near,
            'shared_source_pairs':sources,'shared_long_message_diagnostics':shared_long_messages,
            'comparison_count':len(comparisons),'comparison_hash':history.digest(comparisons),
            'policy':{'normalization':'NFKC, casefold, whitespace collapse; context role/body and unchanged complete target',
                      'near':'character 3gram Jaccard','near_threshold':near_threshold,'min_near_chars':min_near_chars,
                      'short_target_alone_not_leakage':True,'shared_long_message_min_chars':80,
                      'semantic_paraphrase_detection_not_claimed':True}}
    result['audit_hash']=history.digest(result)
    return result
