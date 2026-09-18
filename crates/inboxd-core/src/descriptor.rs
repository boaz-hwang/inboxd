use std::{io, mem::MaybeUninit, os::fd::RawFd};

fn identity_field<T: TryInto<u64>>(value: T, name: &str) -> io::Result<u64> {
    value.try_into().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("descriptor {name} is out of range"),
        )
    })
}

/// Stable identity and regular-file status read directly from an open Unix
/// descriptor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DescriptorIdentity {
    pub device: u64,
    pub inode: u64,
    pub is_regular: bool,
}

/// Reads identity from a borrowed descriptor with exactly one `fstat` call.
///
/// This function never opens, duplicates, closes, seeks, mutates, or assumes
/// ownership of the descriptor. The caller remains responsible for keeping the
/// descriptor open and preventing descriptor-number reuse during this call.
/// A negative descriptor is rejected before FFI; all `fstat` failures are
/// returned as their operating-system error.
pub fn descriptor_identity(fd: RawFd) -> io::Result<DescriptorIdentity> {
    if fd < 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "descriptor must be non-negative",
        ));
    }

    let mut status = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `status` points to writable storage for one `libc::stat`, and
    // `fstat` only borrows the descriptor integer for the duration of the call.
    // It does not take ownership. We read `status` only after success.
    if unsafe { libc::fstat(fd, status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful `fstat` initialized the complete `libc::stat` value.
    let status = unsafe { status.assume_init() };
    let is_regular = status.st_mode & libc::S_IFMT == libc::S_IFREG;
    if !is_regular {
        return Ok(DescriptorIdentity {
            device: 0,
            inode: 0,
            is_regular: false,
        });
    }
    let device = identity_field(status.st_dev, "device")?;
    let inode = identity_field(status.st_ino, "inode")?;

    Ok(DescriptorIdentity {
        device,
        inode,
        is_regular,
    })
}
