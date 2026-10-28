import AppIntents

enum AskControlDestination: String, AppEnum {
    case chat

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Open my chat"
    static var caseDisplayRepresentations: [AskControlDestination: DisplayRepresentation] = [
        .chat: "Open my chat"
    ]
}

// Both targets expose the same OpenIntent so the system runs it in App.
// ForegroundContinuableIntent itself is unavailable to app extensions.
struct OpenAskControlIntent: OpenIntent {
    static var title: LocalizedStringResource = "Ask Murage"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    @Parameter(title: "Open my chat", default: .chat)
    var target: AskControlDestination

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !ASK_CONTROL_EXTENSION
        // Resolve the last bot and open its composer using N13's app-only path.
        _ = try await OpenAskIntent().perform()
        #endif
        return .result()
    }
}
