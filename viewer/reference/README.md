/* The v5 bundle as it shipped, preserved as the ORACLE for the differential tests.
 *
 * This is a byte copy of `web/viewer.js` as of 2026-09-02, taken before the rebuilt
 * bundle replaced it. It is here because it has to be: `check-bundle.mjs` and
 * `check-equivalence.mjs` compare the candidate against the shipped artifact, and once
 * the candidate IS the shipped artifact those tests would be comparing a file with
 * itself and passing vacuously.
 *
 * It is also the only copy. There is no git history in this tree -- the `.git` directory
 * went with everything else on 2026-09-01 -- and this file was the sole surviving record
 * of the lost `viewer/` source. Deleting it would discard the specification the
 * reconstruction is checked against.
 */
