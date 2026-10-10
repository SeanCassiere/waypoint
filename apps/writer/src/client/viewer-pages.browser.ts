// Page-specific script for Changes and gallery pages, kept out of the shared shell bundle.
import { bindChangesNav } from "./changes-nav.ts";
import { bindFolds } from "./folds.ts";
import { bindGallery } from "./gallery.ts";

bindChangesNav();
bindFolds();
bindGallery();
