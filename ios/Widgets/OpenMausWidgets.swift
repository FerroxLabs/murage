// The widget extension: the bot's Live Activity, in the Dynamic Island and
// on the lock screen. The face is the mascot engine's resting face for the
// state — the system renders a snapshot, so it cannot move here, but it
// changes with every update.
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct OpenMausWidgets: WidgetBundle {
    var body: some Widget {
        BotActivityWidget()
    }
}

struct BotActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    MausFaceStill(color: context.attributes.color, state: MausState(rawValue: context.state.face) ?? .idle, size: 64)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.headline)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                        Text(context.state.line)
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.7))
                            .lineLimit(2)
                    }
                    .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.state.kind == "needsYou", let requestId = context.state.requestId, !context.state.options.isEmpty {
                        AnswerButtons(context: context, requestId: requestId)
                            .padding(.top, 4)
                    }
                }
            } compactLeading: {
                MausFaceStill(color: context.attributes.color, state: MausState(rawValue: context.state.face) ?? .idle, size: 24)
            } compactTrailing: {
                compactTrailing(context)
            } minimal: {
                MausFaceStill(color: context.attributes.color, state: MausState(rawValue: context.state.face) ?? .idle, size: 22)
            }
            .keylineTint(MausPalette.color(context.attributes.color))
        }
    }

    @ViewBuilder
    private func compactTrailing(_ context: ActivityViewContext<BotActivityAttributes>) -> some View {
        switch context.state.kind {
        case "needsYou":
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(MausPalette.color(context.attributes.color))
        case "working":
            Image(systemName: "circle.dotted")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.8))
        default:
            Circle().fill(MausPalette.color(context.attributes.color)).frame(width: 8, height: 8)
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            MausFaceStill(color: context.attributes.color, state: MausState(rawValue: context.state.face) ?? .idle, size: 56)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if context.state.kind == "needsYou" {
                        Image(systemName: "hand.raised.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(MausPalette.color(context.attributes.color))
                    }
                    Text(context.state.headline)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                }
                Text(context.state.line)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(2)
                if context.state.kind == "needsYou", let requestId = context.state.requestId, !context.state.options.isEmpty {
                    AnswerButtons(context: context, requestId: requestId)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

/// The card's options, as pills — exactly the options the card offered.
private struct AnswerButtons: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let requestId: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(context.state.options, id: \.self) { option in
                Button(intent: AnswerApprovalIntent(
                    threadId: context.attributes.threadId,
                    requestId: requestId,
                    choice: option,
                    isPermission: context.state.isPermission
                )) {
                    Text(option)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background(
                            Capsule().fill(
                                option.caseInsensitiveCompare("Deny") == .orderedSame
                                    ? Color.white.opacity(0.16)
                                    : MausPalette.color(context.attributes.color)
                            )
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}
