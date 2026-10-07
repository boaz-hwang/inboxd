"""Lossless metadata prototype; production reply-v4 remains unchanged.

This module does not select messages, rewrite bodies, or infer importance.
Author aliases and timestamp offsets round-trip to the original turn metadata.
Adoption requires a new shared prompt version and a separately reviewed dataset.
"""
import copy
from decimal import Decimal
import math


def compact_metadata(metadata):
    result = copy.deepcopy(metadata)
    fields = result['turn_fields']
    author_index, time_index = fields.index('author_id'), fields.index('ts')
    turns = result['turn_metadata']
    authors = list(dict.fromkeys(turn[author_index] for turn in turns))
    for turn in turns:
        turn[author_index] = authors.index(turn[author_index])
    result['author_ids'] = authors
    timestamps = [turn[time_index] for turn in turns]
    numeric = timestamps and all(type(value) in (int, float) and math.isfinite(value)
                                 for value in timestamps)
    if numeric:
        origin = timestamps[-1]
        offsets = []
        for timestamp in timestamps:
            offset = Decimal(str(timestamp)) - Decimal(str(origin))
            number = int(offset) if offset == int(offset) else float(offset)
            if Decimal(str(number)) + Decimal(str(origin)) != Decimal(str(timestamp)):
                numeric = False
                break
            offsets.append(number)
        if numeric:
            for turn, offset in zip(turns, offsets):
                turn[time_index] = offset
            result['ts_origin'] = origin
    result['ts_encoding'] = 'offset_seconds' if numeric else 'absolute_seconds'
    return result


def expand_metadata(compact):
    result = copy.deepcopy(compact)
    authors = result.pop('author_ids')
    encoding = result.pop('ts_encoding')
    origin = result.pop('ts_origin', None)
    fields = result['turn_fields']
    author_index, time_index = fields.index('author_id'), fields.index('ts')
    for turn in result['turn_metadata']:
        turn[author_index] = authors[turn[author_index]]
        if encoding == 'offset_seconds':
            timestamp = Decimal(str(origin)) + Decimal(str(turn[time_index]))
            turn[time_index] = int(timestamp) if timestamp == int(timestamp) else float(timestamp)
    return result
