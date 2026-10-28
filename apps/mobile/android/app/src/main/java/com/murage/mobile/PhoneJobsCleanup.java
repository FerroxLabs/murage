package com.murage.mobile;

import com.murage.mobile.shell.WorkspaceOrigin;

/** Local removal never waits for the best-effort DELETE. */
final class PhoneJobsCleanup {
    interface State {
        String token(WorkspaceOrigin workspace) throws Exception;
        void removeToken(WorkspaceOrigin workspace) throws Exception;
        void removeConsent(WorkspaceOrigin workspace) throws Exception;
        void clearLedger(WorkspaceOrigin workspace) throws Exception;
    }
    private final State state;
    private final PhoneJobRunner.HTTP http;
    PhoneJobsCleanup(State state, PhoneJobRunner.HTTP http) { this.state = state; this.http = http; }
    boolean forget(WorkspaceOrigin workspace) {
        String token = null;
        try { token = state.token(workspace); } catch (Exception unreadable) { }
        boolean cleared = true;
        try { state.removeToken(workspace); } catch (Exception error) { cleared = false; }
        try { state.removeConsent(workspace); } catch (Exception error) { cleared = false; }
        try { state.clearLedger(workspace); } catch (Exception error) { cleared = false; }
        if (token != null) http.send(workspace, token, "DELETE", "", null, 3000, ignored -> {});
        return cleared;
    }
}
