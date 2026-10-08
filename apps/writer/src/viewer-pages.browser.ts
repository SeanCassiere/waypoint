// Page-specific script for Changes and gallery pages, kept out of the shared shell bundle.
import { bindChangesNav } from "./client/changes-nav.ts";
import { bindFolds } from "./client/folds.ts";
import { bindGallery } from "./client/gallery.ts";

bindChangesNav();
bindFolds();
bindGallery();
