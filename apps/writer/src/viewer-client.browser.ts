import { bindActions } from "./client/actions.js";
import { bindFrameSync } from "./client/frame-sync.js";
import { localizeTimes } from "./client/time.js";

localizeTimes();
bindActions();
bindFrameSync();
