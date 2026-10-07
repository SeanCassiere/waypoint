// Page-specific script for Changes and gallery pages, kept out of the shared shell bundle.
import { bindChangesNav } from "./client/changes-nav.js";
import { bindFolds } from "./client/folds.js";
import { bindGallery } from "./client/gallery.js";

bindChangesNav();
bindFolds();
bindGallery();
