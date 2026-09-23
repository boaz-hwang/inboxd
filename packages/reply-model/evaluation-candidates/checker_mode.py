"""Isolated mode-aware checker candidate, not used by the production worker."""

import json

from checker_frame import frame_first_variant


def mode_aware_variant(baseline_messages):
    """Ask for actor extraction only when replying to another person's turn."""
    payload = json.loads(baseline_messages[-1]["content"])
    reply_mode = payload["context"]["reply_mode"]
    if reply_mode == "reply_other":
        return frame_first_variant(baseline_messages)
    if reply_mode == "continue_self":
        return [dict(message) for message in baseline_messages]
    raise ValueError("invalid_checker_reply_mode")
