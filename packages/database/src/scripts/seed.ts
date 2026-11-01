import { closeDb, getDb } from "../client";
import { seedReferenceData } from "../seed";

seedReferenceData(getDb())
  .then(() => console.log("Reference data synchronised."))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
