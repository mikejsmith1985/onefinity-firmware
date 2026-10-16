Install: download onefinity-1.27.2.tar.bz2 (not the source zips), then use Admin > General > Upgrade via web or Upgrade from file. Do not extract the file. This release includes everything from 1.17.3 through 1.27.1, so you can go straight to it from 1.17.2 or later. Do not upgrade in the middle of a job, because the controller restarts. An interrupted job is kept through the upgrade and can still be resumed.

## Fixed in 1.27.2: the work zero comes back after a restart

After a restart, the controller puts the work zero back when you home. But it only remembered a zero set with the Zero buttons. A zero set by probing (Probe XYZ, Probe center, Measure stock, the tool setter) was forgotten, so homing after a restart brought back an older zero from whenever a Zero button was last used. A resumed job would then cut in the wrong place.

The controller now saves the live zero whenever the machine settles idle with that axis homed. Homing after a restart brings back the zero you last set, however you set it.

## New in 1.27.2: put the zero back when resuming

An interrupted job saves the work zero it was using. The Resume dialog now compares it with the current zero, both before and after building the resume program. If they differ, you can put the saved zero back without probing the part, which is often impossible once it's half cut:

- **Put back X, Y and Z:** use this when the cutter hasn't been taken out of the collet or moved in it since the job stopped. You confirm that with a checkbox first.
- **Put back X and Y only:** use this if the cutter was changed or re-seated. Then set Z zero again on an uncut part of the stock top before running.

It only works on a homed, idle machine, because the saved zero is relative to home. Restoring from the "Resume program ready" screen rebuilds the program and checks the zero again.

## Testing

- **Saving the zero:** a probed zero is saved and comes back after a restart, and nothing is written when it hasn't changed. The zeros every axis reads right after a restart are never saved over the real one. Unhomed axes and running jobs are left alone.
- **Putting the zero back:** every axis lands exactly on the saved zero, X and Y only leaves Z alone, inch mode works, and it refuses on an unhomed or busy machine.
- **On a simulated controller:** the Resume dialog with a zero that changed after a restart, restored before building, and restored from the ready screen with X and Y only, which then warns about Z only.
- **Not yet tested on real hardware.**
