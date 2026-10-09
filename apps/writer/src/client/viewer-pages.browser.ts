// Page-specific script for Changes and gallery pages, kept out of the shared shell bundle.
import { bindChangesNav } from "./changes-nav.ts";
import { fillDims } from "./dims.ts";
import { bindFolds } from "./folds.ts";
import { bindGallery } from "./gallery.ts";

bindChangesNav();
bindFolds();
bindGallery();
// Image sizes after load on Changes (removed images, image pairs); Gallery tiles bind their own.
fillDims();
