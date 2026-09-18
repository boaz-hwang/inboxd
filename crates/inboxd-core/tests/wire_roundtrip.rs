use inboxd_core::{wire_from_utf16_units, wire_utf16_units};

#[test]
fn encodes_utf16_without_losing_surrogates_or_reserved_scalars() {
    let cases: &[(&[u16], &str)] = &[
        (&[], ""),
        (&[0x0041, 0], "A\0"),
        (&[0xD800], "\u{F0000}"),
        (&[0xDFFF], "\u{F07FF}"),
        (&[0xD83D, 0xDE00], "😀"),
        (&[0xDB80, 0xDC00], "\u{F0800}\u{F0000}"),
        (&[0xDB82, 0xDC00], "\u{F0800}\u{F0800}"),
        (&[0xD800, 0x0041, 0xDC00], "\u{F0000}A\u{F0400}"),
    ];
    for (units, expected) in cases {
        let encoded = wire_from_utf16_units(units);
        assert_eq!(&encoded, expected);
        assert_eq!(wire_utf16_units(&encoded).unwrap(), *units);
    }
}

#[test]
fn every_utf16_unit_survives_a_wire_roundtrip() {
    for unit in 0..=u16::MAX {
        let encoded = wire_from_utf16_units(&[unit]);
        assert_eq!(wire_utf16_units(&encoded).unwrap(), [unit]);
    }
}
