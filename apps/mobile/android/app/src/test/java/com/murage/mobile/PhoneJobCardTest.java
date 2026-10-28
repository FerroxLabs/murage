package com.murage.mobile;

import java.util.*;
import java.util.function.Consumer;
import com.murage.mobile.shell.PhoneJobsContract;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneJobCardTest {
    private PhoneJobsContract.Offer offer(String action, JSONObject args) {
        PhoneJobsContract.Offer offer = PhoneJobsContract.Offer.parse(PhoneJobRunner.json(
            "operationId", "a1b2c3d4-0000-4000-8000-000000000001", "offerId", "a1b2c3d4-0000-4000-8000-000000000002",
            "workspace", "Studio", "bot", PhoneJobRunner.json("id", "ember", "name", "Ember"),
            "capability", action.substring(0, action.indexOf('.')), "action", action, "args", args, "say", "Please allow",
            "provider", PhoneJobRunner.json("id", "provider", "name", "Provider"), "expiresAt", 1790000000000L, "leaseMs", 45000));
        assertNotNull(offer); return offer;
    }
    @Test public void validatedDialNumberAndEachRecipientStayUnchangedBeforeAllow() {
        String number = "+1 (555) 010-20.30";
        PhoneJobCardModel dial = new PhoneJobCardModel(offer("calls.dial", PhoneJobRunner.json("number", number)), 1, ignored -> {});
        assertEquals(PhoneJobCardModel.State.OFFER, dial.state());
        assertEquals(Collections.singletonList(number), dial.destinations);
        JSONArray recipients = new JSONArray().put(number).put("+44 (20) 1234");
        PhoneJobCardModel message = new PhoneJobCardModel(offer("messages.compose", PhoneJobRunner.json("to", recipients, "body", "Hi")), 1, ignored -> {});
        assertEquals(PhoneJobCardModel.State.OFFER, message.state());
        assertEquals(Arrays.asList(number, "+44 (20) 1234"), message.destinations);
        assertTrue(model(1, ignored -> {}).destinations.isEmpty());
    }
    private PhoneJobCardModel model(int count, Consumer<Boolean> answer) {
        return new PhoneJobCardModel("Ember", "calendar", "Read tomorrow's events", "Studio", count, answer);
    }
    @Test public void workspacePresentationRequiresTheJobComputerAndOffscreenCardNamesIt() {
        com.murage.mobile.shell.WorkspaceOrigin one = com.murage.mobile.shell.WorkspaceOrigin.parse("https://one.example.ts.net");
        com.murage.mobile.shell.WorkspaceOrigin two = com.murage.mobile.shell.WorkspaceOrigin.parse("https://two.example.ts.net");
        assertTrue(PhoneJobCardModel.matches(one, one));
        assertFalse(PhoneJobCardModel.matches(one, two));
        assertFalse(PhoneJobCardModel.matches(one, null));
        PhoneJobCardModel card = new PhoneJobCardModel("Ember", "calendar", "Read events", "Stu\u202edio\n", 1, true, ignored -> {});
        assertEquals("Studio", card.workspace);
        assertEquals("Fixed warning.\n\nAcmeAI\n\nStudio",
            PhoneDataSharingText.message("Fixed warning.", "Acme\nAI", "Stu\u202edio\n"));
    }
    @Test public void workspaceNameOnlyWithTwoEnabledWorkspaces() {
        assertNull(model(1, ignored -> {}).workspace);
        assertEquals("Studio", model(2, ignored -> {}).workspace);
    }
    @Test public void eachChoiceCallsBackOnceIncludingReentrantAndOppositeTaps() {
        for (boolean allow : new boolean[]{true, false}) {
            List<Boolean> answers = new ArrayList<>();
            PhoneJobCardModel[] card = new PhoneJobCardModel[1];
            card[0] = model(1, value -> { answers.add(value); card[0].choose(!value); });
            card[0].choose(allow); card[0].choose(allow); card[0].choose(!allow);
            assertEquals(Collections.singletonList(allow), answers);
            assertEquals(PhoneJobCardModel.State.WAITING, card[0].state());
        }
    }
    @Test public void backgroundDismissalDropsChoicesAndCompletionCallbacks() {
        PhoneJobCardModel card = model(1, ignored -> fail("dismissed card answered"));
        card.dismiss(); card.choose(true); card.choose(false);
        card.complete(() -> fail("dismissed card revived")); card.close();
        assertEquals(PhoneJobCardModel.State.DISMISSED, card.state());
        PhoneJobCardModel used = model(1, ignored -> {});
        used.complete(() -> fail("background close was a user action")); used.dismiss(); used.close();
    }
    @Test public void alreadyHandledReplacesTheChoiceAndClosesOnce() {
        PhoneJobCardModel card = model(1, ignored -> fail("handled card answered"));
        int[] closes = {0};
        card.alreadyHandled(() -> closes[0]++);
        assertEquals(PhoneJobCardModel.State.HANDLED, card.state());
        card.choose(true); card.choose(false); card.close(); card.close();
        assertEquals(1, closes[0]);
    }
    @Test public void completedRunReplacesActionsAndClosesOnce() {
        PhoneJobCardModel card = model(1, ignored -> {}); int[] closes = {0};
        card.choose(true); card.complete(() -> closes[0]++);
        assertEquals(PhoneJobCardModel.State.USED, card.state());
        assertEquals("Ember", card.bot); assertEquals("calendar", card.capability);
        card.close(); card.close(); assertEquals(1, closes[0]);
    }
    @Test public void untrustedBotSayAndWorkspaceStayPlainAndBounded() {
        PhoneJobCardModel card = new PhoneJobCardModel("<b>Em\u202eber</b>\n\n\u2069", "calendar",
            "Read\u202e\n\n\n\nthis\u2066\r\t\u0000\u2028 <i>text</i>", "Stu\u200ddio\n\u2029", 2, ignored -> {});
        assertEquals("<b>Ember</b>", card.bot);
        assertEquals("Read\n\nthis <i>text</i>", card.say);
        assertEquals("Studio", card.workspace);
        PhoneJobCardModel longCard = new PhoneJobCardModel(repeat("😀", 100), "calendar", repeat("a", 300), repeat("b", 200), 2, ignored -> {});
        assertEquals(120, longCard.bot.length()); assertEquals(240, longCard.say.length());
        assertEquals(120, longCard.workspace.length());
        assertEquals(120, PhoneDataSharingText.providerLine(repeat("p", 200)).length());
        assertEquals(119, PhoneDataSharingText.plain(repeat("a", 119) + "😀", 120, 0).length());
    }
    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < count; i++) result.append(value);
        return result.toString();
    }
    @Test public void allWriteDetailsUseValidatedSnapshotAndFilteredPlainText() {
        String start = "2026-10-27T09:00:00Z", end = "2026-10-27T10:00:00Z";
        Object[][] cases = {
            {"calendar.add", PhoneJobRunner.json("title", "Lunch\u202e", "start", start, "end", end, "allDay", true, "location", "Cafe", "notes", "Bring notes"),
                Arrays.asList("title=Lunch", "start=" + start, "end=" + end, "all_day=@yes", "location=Cafe", "notes=Bring notes")},
            {"calendar.change", PhoneJobRunner.json("id", "event", "title", "New title", "start", start, "end", end, "location", "", "notes", "New notes"),
                Arrays.asList("current_item=Original", "id=event", "title=New title", "start=" + start, "end=" + end, "location=", "notes=New notes")},
            {"reminders.add", PhoneJobRunner.json("title", "Buy milk", "due", start, "notes", "Two bottles"), Arrays.asList("title=Buy milk", "due=" + start, "notes=Two bottles")},
            {"reminders.complete", PhoneJobRunner.json("id", "reminder"), Arrays.asList("current_item=Original", "id=reminder", "completed=@yes")},
            {"alarms.set", PhoneJobRunner.json("hour", 7, "minute", 5, "label", "Wake"), Arrays.asList("time=07:05", "label=Wake")},
            {"alarms.timer", PhoneJobRunner.json("seconds", 90, "label", "Tea"), Arrays.asList("seconds=90", "label=Tea")},
            {"messages.compose", PhoneJobRunner.json("to", new JSONArray().put("+123"), "body", "Hello"), Arrays.asList("message=Hello")}
        };
        for (Object[] row : cases) {
            PhoneJobsContract.Offer offer = offer((String) row[0], (JSONObject) row[1]);
            PhoneJobsContract.Args args = offer.decodedArgs(); assertNotNull(args);
            PhoneJobCardModel card = new PhoneJobCardModel(offer, args, "Ori\u202eginal", 1, ignored -> {});
            List<String> actual = new ArrayList<>();
            for (PhoneJobCardModel.Detail detail : card.details) actual.add(detail.key.substring("phone_detail_".length()) + "=" + detail.value);
            assertEquals(row[0].toString(), row[2], actual);
        }
    }
    @Test public void dialCodesAreRejectedForCallsAndMessages() {
        for (String number : Arrays.asList("*123", "123#", "*#06#")) {
            assertFalse(PhoneJobsContract.isDialNumber(number));
            assertNull(offer("calls.dial", PhoneJobRunner.json("number", number)).decodedArgs());
            assertNull(offer("messages.compose", PhoneJobRunner.json("to", new JSONArray().put(number), "body", "Hi")).decodedArgs());
        }
    }

}
