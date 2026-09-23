import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "evaluation-candidates"))
from checker_thinking import extract_final_text


class ThinkingBoundaryTest(unittest.TestCase):
    def test_template_opened_thought_yields_only_final_json(self):
        self.assertEqual(
            extract_final_text('private reasoning</think>{"supported":false}', prompt_opens_thought=True),
            '{"supported":false}',
        )

    def test_generated_opening_tag_yields_only_final_json(self):
        self.assertEqual(
            extract_final_text('<think>private reasoning</think>{"supported":true}', prompt_opens_thought=False),
            '{"supported":true}',
        )

    def test_unclosed_thought_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "check_reasoning_truncated"):
            extract_final_text('private reasoning', prompt_opens_thought=True)
        with self.assertRaisesRegex(ValueError, "check_reasoning_truncated"):
            extract_final_text('<think>private reasoning', prompt_opens_thought=False)

    def test_non_thinking_final_json_is_unchanged(self):
        self.assertEqual(
            extract_final_text('{"supported":true}', prompt_opens_thought=False),
            '{"supported":true}',
        )


if __name__ == "__main__":
    unittest.main()
