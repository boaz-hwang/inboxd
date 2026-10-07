import unittest
from unittest.mock import patch
import multi_adapter as m

class DiagnosticGateTests(unittest.TestCase):
    def run_summary(self, reasons, failures=0):
        policy={'suite_hash':'s','gating_comparators':['base'],'diagnostic_comparators':['prior'],'comparison_hash':'p'}
        suite={'suite_hash':'s','comparators':['base','prior'],'candidate':'candidate'}
        result={'methods':{'candidate':{'clear_semantic_failure_cases':failures}},'gate_reasons':reasons}
        with patch.object(m,'read',return_value=policy),patch.object(m,'check_seal'),patch.object(m,'load_suite',return_value=suite),patch.object(m,'summarize',return_value=result):
            return m.summarize_with_diagnostics('suite','report','verdict','policy')
    def test_prior_is_diagnostic_only(self):
        r=self.run_summary(['no_meaningful_paired_gain_vs_prior'])
        self.assertEqual(r['gate'],'pass');self.assertFalse(r['activation_authorized'])
        self.assertEqual(len(r['diagnostic_gate_reasons']),1)
    def test_base_failure_preserved(self):
        r=self.run_summary(['usefulness_regresses_vs_base','no_meaningful_score_gain_vs_prior'])
        self.assertEqual(r['gate'],'hold');self.assertEqual(r['gate_reasons'],['usefulness_regresses_vs_base'])
    def test_absolute_clear_failure_never_removed(self):
        r=self.run_summary(['candidate_clear_semantic_failure','no_meaningful_score_gain_vs_prior'],1)
        self.assertEqual(r['gate'],'reject')
    def test_uncertainty_never_removed(self):
        r=self.run_summary(['candidate_unresolved_semantic_judgment'])
        self.assertEqual(r['gate'],'hold')

if __name__=='__main__':unittest.main()
