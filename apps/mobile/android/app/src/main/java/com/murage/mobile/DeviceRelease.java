package com.murage.mobile;

/**
 * Releasing this phone's Firebase identifiers when its last computer goes.
 * Each step is tried whatever the other did; a failure is logged by exception
 * class alone, because a message could carry the token.
 */
final class DeviceRelease {
    interface Step { void run() throws Exception; }

    private DeviceRelease() {}

    static void run(Step deleteToken, Step deleteInstallation) {
        attempt("token", deleteToken);
        attempt("installation", deleteInstallation);
    }

    private static void attempt(String what, Step step) {
        try {
            step.run();
        } catch (Exception failed) {
            ShellLog.i("push release " + what + " failed error=" + failed.getClass().getSimpleName());
        }
    }
}
