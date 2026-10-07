import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from review_duplicates import cross_split_audit

class DuplicateTests(unittest.TestCase):
 def r(self,id,body,target='thanks'):
  return {'id':id,'context':[{'author_role':'other','body':body}], 'targets':[{'body':target}], 'source_message_keys':[id]}
 def test_normalized_episode_and_sources_but_not_short_ack_alone(self):
  a=self.r('train','An isolated\nsynthetic episode');b=self.r('test','an isolated synthetic episode')
  audit=cross_split_audit([a],[b]);self.assertEqual(len(audit['normalized_full_episode_exact_pairs']),1)
  c=self.r('unrelated','A different request');self.assertEqual(cross_split_audit([c],[b])['normalized_full_episode_exact_pairs'],[])
  c['source_message_keys']=['test'];self.assertEqual(len(cross_split_audit([c],[b])['shared_source_pairs']),1)
 def test_long_near_episode_is_reported_without_bodies(self):
  body=' '.join('synthetic isolated fixture event '+str(i) for i in range(100));a=self.r('train',body);b=self.r('test',body+' changed')
  audit=cross_split_audit([a],[b]);self.assertEqual(len(audit['long_episode_near_pairs']),1)
  self.assertNotIn('synthetic common invitation',str(audit))
if __name__=='__main__':unittest.main()
