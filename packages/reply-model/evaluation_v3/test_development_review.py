import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import development_review as d
from independent import read

class ReviewPacketTests(unittest.TestCase):
    def test_packets_disjoint_and_mapping_absent(self):
        views=[{'id':str(i),'request':{},'rubric':{},'outputs':[{'label':'option_1','output_hash':'h','text':'Synthetic output'}]} for i in range(24)]
        with tempfile.TemporaryDirectory() as tmp,patch.object(d,'dev_suite'),patch.object(d,'review_view',return_value=({'suite_hash':'s'},{'report_hash':'r'},views)):
            path=Path(tmp)/'review';result=d.prepare_packets('suite','report',path)
            a,b=read(path/'root-packet.json'),read(path/'dataset-packet.json')
            self.assertFalse({x['id'] for x in a['cases']} & {x['id'] for x in b['cases']})
            self.assertEqual(len(a['cases'])+len(b['cases']),24)
            self.assertNotIn('mapping',a);self.assertFalse(result['mapping_read'])
    def test_final_name_checked_before_report_read(self):
        with patch.object(d,'review_view') as read:
            with self.assertRaisesRegex(ValueError,'before_read'):d.prepare_packets('final-compiled-v4-frozen.json','report','unused')
            read.assert_not_called()

if __name__=='__main__':unittest.main()
