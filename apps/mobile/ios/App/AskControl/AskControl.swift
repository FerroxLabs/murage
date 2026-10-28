import AppIntents
import SwiftUI
import WidgetKit

@main
struct AskControlBundle: WidgetBundle {
    var body: some Widget {
        // The extension retains the iOS 17 floor and exports no control there.
        if #available(iOS 18.0, *) {
            AskControl()
        }
    }
}

@available(iOS 18.0, *)
struct AskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.murage.mobile.AskControl") {
            ControlWidgetButton(action: OpenAskControlIntent()) {
                Label("Ask Murage", systemImage: "square.and.pencil")
            }
        }
        .displayName("Ask Murage")
    }
}
