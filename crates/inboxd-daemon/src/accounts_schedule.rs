//! Bounded account work and FIFO provider scheduling. A job owns its traversal
//! future; only a single SDK primitive/batch owns the worker mutex. Reacquiring
//! Tokio's FIFO mutex puts the next page behind already waiting jobs.
use super::WorkerProcess;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

pub(super) struct Schedule {
    pub(super) sends: Mutex<()>,
    pub(super) live: tokio::sync::watch::Sender<super::live::LiveSignal>,
    pub(super) worker: Mutex<Option<WorkerProcess>>,
    jobs: Arc<Semaphore>,
    reads: Arc<Semaphore>,
}
pub(super) struct Admission {
    _job: OwnedSemaphorePermit,
    _read: Option<OwnedSemaphorePermit>,
}
impl Default for Schedule {
    fn default() -> Self {
        Self {
            live: tokio::sync::watch::channel(Default::default()).0,
            worker: Mutex::new(None),
            sends: Mutex::new(()),
            jobs: Arc::new(Semaphore::new(4)),
            // Three traversals can coexist; leave capacity for an owner send.
            reads: Arc::new(Semaphore::new(3)),
        }
    }
}
impl Schedule {
    pub(super) fn admit(&self, send: bool) -> Result<Admission, String> {
        let read = if send {
            None
        } else {
            Some(
                Arc::clone(&self.reads)
                    .try_acquire_owned()
                    .map_err(|_| "계정 조회 작업이 많습니다. 잠시 후 다시 시도하세요")?,
            )
        };
        let job = Arc::clone(&self.jobs)
            .try_acquire_owned()
            .map_err(|_| "계정 작업이 많습니다. 잠시 후 다시 시도하세요")?;
        Ok(Admission {
            _job: job,
            _read: read,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_is_bounded_and_reserves_send_capacity() {
        let schedule = Schedule::default();
        let reads: Vec<_> = (0..3).map(|_| schedule.admit(false).unwrap()).collect();
        assert!(schedule.admit(false).is_err());
        let send = schedule.admit(true).unwrap();
        assert!(schedule.admit(true).is_err());
        drop(reads);
        assert!(schedule.admit(false).is_ok());
        drop(send);
    }
}
