import adapters from "./adapters.mjs";
import agents from "./agents.mjs";
import approve from "./approve.mjs";
import cancel from "./cancel.mjs";
import doctor from "./doctor.mjs";
import events from "./events.mjs";
import extend from "./extend.mjs";
import inbox from "./inbox.mjs";
import inject from "./inject.mjs";
import inspect from "./inspect.mjs";
import proposals from "./proposals.mjs";
import ps from "./ps.mjs";
import reject from "./reject.mjs";
import repos from "./repos.mjs";
import requeue from "./requeue.mjs";
import retry from "./retry.mjs";
import runs from "./runs.mjs";
import sandbox from "./sandbox.mjs";
import schedule from "./schedule.mjs";
import serve from "./serve.mjs";
import status from "./status.mjs";
import supervise from "./supervise.mjs";
import trace from "./trace.mjs";
import updatePins from "./update-pins.mjs";
import work from "./work.mjs";
import workers from "./workers.mjs";

export const COMMANDS = Object.freeze({
  serve,
  work,
  supervise,
  status,
  doctor,
  events,
  runs,
  ps,
  proposals,
  inbox,
  agents,
  adapters,
  workers,
  schedule,
  repos,
  sandbox,
  approve,
  reject,
  inject,
  requeue,
  cancel,
  retry,
  extend,
  inspect,
  trace,
  "update-pins": updatePins,
});

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));
