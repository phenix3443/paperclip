// Claim fence for a stopping server (graceful-stop plan, rule 4). A scheduler
// tick already inside its claim transaction can commit after the shutdown
// began. Once the scheduler quiesce step has ended, a claimed run is not
// handed to an adapter: it stays running with this boot's controllerBootId
// and the next boot's orphan sweep requeues it.
let fenced = false;

export function fenceHeartbeatRunDispatch() {
  fenced = true;
}

export function heartbeatRunDispatchFenced() {
  return fenced;
}

export function resetHeartbeatRunDispatchFenceForTests() {
  fenced = false;
}
