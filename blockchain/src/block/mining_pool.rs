use crate::block::miner::MiningTask;
use crate::election::ElectionManifest;

// Simple FIFO-ish queue of pending mining tasks, keyed by key image so one voter can never have
// more than one ballot queued at once.
pub struct MiningPool {
    tasks: Vec<MiningTask>,
}

impl MiningPool {
    pub fn new() -> Self {
        Self { tasks: vec![] }
    }

    pub fn contains_key_image(&self, key_image: &[u8]) -> bool {
        self.tasks.iter().any(|t| t.key_image == key_image)
    }

    // Adds the task unless one from the same voter is already queued.
    // Returns whether the task was added.
    pub fn add_task(&mut self, task: MiningTask, election: &ElectionManifest) -> bool {
        if self.contains_key_image(&task.key_image) {
            return false;
        }
        if !election.is_valid_candidate(&task.candidate) {
            return false;
        }
        self.tasks.push(task);
        true
    }

    // Removes and returns the most recently added task.
    pub fn take_last(&mut self) -> Option<MiningTask> {
        self.tasks.pop()
    }

    // Puts a task back in the pool, e.g. after a failed mining attempt.
    pub fn requeue(&mut self, task: MiningTask) {
        self.tasks.push(task);
    }
}
