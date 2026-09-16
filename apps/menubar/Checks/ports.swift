import Foundation

/// Checks for ShellConfig.choosePort, run by tests/menubar-ports.test.ts.
func checkPorts(_ check: (String, Bool) -> Void) {
  check("takes the usual port when it is free", ShellConfig.choosePort(preferred: 4747, isFree: { _ in true }) == 4747)
  // Something else on 4747 used to stop the app dead; now it steps to the next free one.
  check("steps past a taken port", ShellConfig.choosePort(preferred: 4747, isFree: { $0 != 4747 }) == 4748)
  check("keeps stepping while ports are taken", ShellConfig.choosePort(preferred: 4747, isFree: { $0 >= 4750 }) == 4750)
  check("gives the usual one back when nothing nearby is free", ShellConfig.choosePort(preferred: 4747, isFree: { _ in false }) == 4747)
  // The real check against the machine: a port only root may bind is not free, a high one is.
  check("a privileged port is not free", !ShellConfig.free(1))
  check("a high unused port is free", ShellConfig.free(49999))
}
