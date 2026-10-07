package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class NotificationPlanTest {
    @Test public void approvalOnApi31OffersApproveDenyOpenBehindAuthentication() {
        NotificationPlan.Plan p = NotificationPlan.of(PushContract.Category.APPROVAL, 31, true);
        assertEquals("approvals", p.channel);
        assertEquals(Arrays.asList("APPROVE", "DENY", "OPEN"), p.actions);
        assertTrue(p.authRequired);
    }
    @Test public void riskyApprovalOffersDenyAndOpen() {
        assertEquals(Arrays.asList("DENY", "OPEN"), NotificationPlan.of(PushContract.Category.APPROVAL_OPEN, 34, true).actions);
    }
    @Test public void belowApi31OffersOpenOnly() {
        assertEquals(Collections.singletonList("OPEN"), NotificationPlan.of(PushContract.Category.APPROVAL, 30, true).actions);
        assertEquals(Collections.singletonList("OPEN"), NotificationPlan.of(PushContract.Category.APPROVAL_OPEN, 29, true).actions);
    }
    @Test public void featureSwitchOffMeansOpenOnly() {
        assertEquals(Collections.singletonList("OPEN"), NotificationPlan.of(PushContract.Category.APPROVAL, 34, false).actions);
    }
    @Test public void questionsOpenDoneHasNothingResolvedIsSilent() {
        assertEquals(Collections.singletonList("OPEN"), NotificationPlan.of(PushContract.Category.QUESTION, 34, true).actions);
        assertEquals(Collections.emptyList(), NotificationPlan.of(PushContract.Category.DONE, 34, true).actions);
        NotificationPlan.Plan resolved = NotificationPlan.of(PushContract.Category.RESOLVED, 34, true);
        assertTrue(resolved.silent);
        assertEquals("finished", resolved.channel);
    }
}
