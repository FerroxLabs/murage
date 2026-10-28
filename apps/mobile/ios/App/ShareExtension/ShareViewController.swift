import SwiftUI
import UIKit
import MurageShellCore

@MainActor
final class ShareViewController: UIViewController {
    private var model: ShareSheetModel?
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareSheetModel(context: extensionContext)
        self.model = model
        let host = UIHostingController(rootView: ShareSheet(model: model))
        host.title = shareString("share_title")
        host.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelShare))
        let navigation = UINavigationController(rootViewController: host)
        addChild(navigation); view.addSubview(navigation.view)
        navigation.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            navigation.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navigation.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            navigation.view.topAnchor.constraint(equalTo: view.topAnchor),
            navigation.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        navigation.didMove(toParent: self)
        model.start()
    }
    @objc private func cancelShare() { model?.cancel() }
}

private func shareString(_ key: String) -> String { NSLocalizedString(key, bundle: .main, comment: "") }

@MainActor
final class ShareSheetModel: ObservableObject {
    @Published var computers: [SavedWorkspace] = []
    @Published var origin = ""
    @Published var targets: PhoneAskContract.TargetsAnswer?
    @Published var target: ShareOutboxState.Target?
    @Published var note = ""
    @Published var preview = ""
    @Published var image: UIImage?
    @Published var loading = true
    @Published var sending = false
    @Published var sentName: String?
    @Published var problem: String?
    @Published var needsOpen = false
    private weak var context: NSExtensionContext?
    private let tokens = PhoneAskTokenStore()
    private let http = ShareTargetsHTTP()
    private let upload = ShareUploadSession()
    private let defaults = UserDefaults(suiteName: ShareContainer.group)
    private var client: ShareTargetsClient?
    private var payload: ShareItemLoader.Payload?
    private var staging: URL?
    private var task: Task<Void, Never>?
    private var providers: [NSItemProvider] = []
    private var loadingItems = true
    private var inputProblem: String?
    init(context: NSExtensionContext?) { self.context = context }

    var canSend: Bool { !loading && !sending && problem == nil && payload != nil && target != nil && note.utf16.count <= 2000 }
    func start() {
        providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        do { try ShareTypePolicy.checkCount(providers.count) }
        catch { fail(error); return }
        guard let root = ShareContainer.root else { setup(); return }
        try? ShareFiles.excludeExisting(root: root)
        client = ShareTargetsClient(cache: .init(root: root), readToken: tokens.readForAsk, removeToken: tokens.remove,
                                    fetch: { [http] origin, token in try await http.fetch(origin, token: token) })
        let book = ShareWorkspaceStore(root: root).read()
        computers = (book?.workspaces ?? []).filter {
            guard let origin = WorkspaceOrigin(string: $0.origin) else { return false }
            return !SharePendingRemovals(root: root).contains(origin)
        }
        guard !computers.isEmpty else { setup(key: "share_pair"); return }
        let last = ShareLastTarget(defaults: defaults).workspace ?? book?.active
        origin = computers.first(where: { $0.origin == last })?.origin ?? computers[0].origin
        selectWorkspace()
        let directory = root.appendingPathComponent("share-staging").appendingPathComponent(UUID().uuidString)
        staging = directory
        task = Task { @MainActor in
            defer { if Task.isCancelled { try? ShareFiles.removeStaging(directory) } }
            do {
                guard let fixture = Bundle.main.url(forResource: "share-types", withExtension: "json") else { throw ShareInputError.invalid }
                let policy = try JSONDecoder().decode(ShareTypePolicy.self, from: Data(contentsOf: fixture))
                let result = try await ShareItemLoader.load(providers, policy: policy, directory: directory)
                payload = result; preview = result.preview
                if let first = result.attachments.first(where: { $0.mime == "image/jpeg" }) {
                    // A second small thumbnail, never a full-size UIImage decode.
                    let thumbnail = directory.appendingPathComponent("preview.jpg")
                    try ShareImagePreparation.prepare(source: first.url, destination: thumbnail) { input, output, _, quality in
                        try makePreview(input, output, quality)
                    }
                    image = UIImage(contentsOfFile: thumbnail.path)
                }
                loadingItems = false; loading = targets == nil && !needsOpen
            } catch { loadingItems = false; fail(error) }
        }
    }
    func selectWorkspace() {
        guard let selected = WorkspaceOrigin(string: origin), let client else { setup(); return }
        pruneSignedOutComputers()
        guard !client.isSignedOut(selected) else { setup(); return }
        targets = nil; target = nil; problem = nil; needsOpen = false
        apply(client.initial(selected, now: Self.now))
        Task { @MainActor in
            let state = await client.open(selected, now: Self.now)
            guard origin == selected.serialized, !sending else { return }
            pruneSignedOutComputers()
            guard !client.isSignedOut(selected) else { setup(); return }
            apply(state)
        }
    }
    private func pruneSignedOutComputers() {
        guard let client else { computers = []; return }
        computers.removeAll {
            guard let origin = WorkspaceOrigin(string: $0.origin) else { return true }
            return client.isSignedOut(origin)
        }
    }
    private func apply(_ state: ShareTargetsClient.State) {
        switch state {
        case .loading: loading = true
        case .setup: setup()
        case .update: setup(key: "share_update")
        case .ready(let answer):
            targets = answer; loading = loadingItems; needsOpen = false; problem = inputProblem
            if let chosen = target, answer.contains(chosen) { return }
            let remembered = ShareLastTarget(defaults: defaults).bot(origin: origin)
            let bot = answer.bots.first(where: { $0.id == remembered }) ?? answer.bots.first
            if let bot { target = .init(botId: bot.id, threadId: bot.mainThreadId) }
        }
    }
    func send() {
        guard canSend, let payload, let target, let selected = WorkspaceOrigin(string: origin), let root = ShareContainer.root, let client else { return }
        pruneSignedOutComputers()
        guard client.allows(target, origin: selected, now: Self.now) else { setup(); return }
        sending = true
        task = Task { @MainActor in
            var prepared: ShareBodyFile.Prepared?
            do {
                guard client.allows(target, origin: selected, now: Self.now),
                      try tokens.readForAsk(origin: selected) != nil else { setup(); sending = false; return }
                // File hashing/writing is not on the UI actor.
                let note = self.note
                let built = try await Task.detached {
                    try ShareBodyFile.prepare(root: root, origin: selected, target: target,
                        shareId: UUID().uuidString, note: note.isEmpty ? nil : note, text: payload.text,
                        url: payload.url, attachments: payload.attachments, now: Self.now)
                }.value
                prepared = built
                try Task.checkCancellation()
                // Re-read after file work. A lock must not schedule a new send.
                guard origin == selected.serialized, client.allows(target, origin: selected, now: Self.now),
                      let token = try tokens.readForAsk(origin: selected) else { throw PhoneAskTokenStore.StoreError.storage }
                guard client.allows(target, origin: selected, now: Self.now) else { throw PhoneAskTokenStore.StoreError.storage }
                try upload.enqueue(built, origin: selected, token: token)
                ShareLastTarget(defaults: defaults).remember(origin: origin, botId: target.botId)
                sentName = targets?.bots.first(where: { $0.id == target.botId })?.name ?? ""
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard !Task.isCancelled else { return }
                finish()
            } catch {
                // A body whose upload never started must not be requeued by N12.
                if let prepared { try? FileManager.default.removeItem(at: prepared.body.deletingLastPathComponent()) }
                sending = false
                pruneSignedOutComputers()
                if error is PhoneAskTokenStore.StoreError { setup(key: "share_again") }
                else { fail(error) }
            }
        }
    }
    private func setup(key: String = "share_setup") { loading = false; needsOpen = true; problem = key; targets = nil; target = nil }
    private func fail(_ error: Error) {
        loading = false; problem = switch error as? ShareInputError {
        case .tooMany: "share_ten"
        case .photoTooLarge: "share_photo_large"
        case .fileTooLarge: "share_file_large"
        default: "share_type"
        }
        inputProblem = problem
    }
    private func cleanUp() {
        task?.cancel()
        if let staging { try? ShareFiles.removeStaging(staging) }
        http.close()
    }
    func cancel() {
        cleanUp()
        context?.cancelRequest(withError: CocoaError(.userCancelled))
    }
    func finish() {
        cleanUp()
        context?.completeRequest(returningItems: nil)
    }
    nonisolated private static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

private struct ShareSheet: View {
    @ObservedObject var model: ShareSheetModel
    var body: some View {
        Form {
            if let name = model.sentName {
                Text(String(format: shareString("share_sent"), name))
            } else {
                if let image = model.image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 140) }
                if !model.preview.isEmpty { Text(model.preview).lineLimit(3) }
                if model.computers.count > 1 {
                    Picker(shareString("share_from"), selection: $model.origin) {
                        ForEach(model.computers, id: \.origin) { Text($0.name).tag($0.origin) }
                    }.disabled(model.sending).onChange(of: model.origin) { _, _ in model.selectWorkspace() }
                }
                if model.loading { ProgressView() }
                if let problem = model.problem { Text(shareString(problem)) }
                if model.needsOpen { Button(shareString("share_done")) { model.finish() } }
                if let targets = model.targets {
                    Picker(shareString("share_to"), selection: $model.target) {
                        ForEach(targets.bots, id: \.id) { bot in
                            Text(bot.name).tag(Optional(ShareOutboxState.Target(botId: bot.id, threadId: bot.mainThreadId)))
                            Text(String(format: shareString("share_new"), bot.name)).tag(Optional(ShareOutboxState.Target(botId: bot.id, threadId: "new")))
                        }
                        Section(shareString("share_recent")) {
                            ForEach(targets.recent, id: \.shareIdentity) { chat in
                                Text(chat.title).tag(Optional(ShareOutboxState.Target(botId: chat.botId, threadId: chat.threadId)))
                            }
                        }
                    }.disabled(model.sending)
                    TextField(shareString("share_note"), text: $model.note, axis: .vertical).disabled(model.sending)
                    Button(shareString(model.sending ? "share_sending" : "share_send")) { model.send() }.disabled(!model.canSend)
                }
            }
        }
    }
}

import ImageIO
import UniformTypeIdentifiers
private func makePreview(_ input: URL, _ output: URL, _ quality: Double) throws {
    guard let source = CGImageSourceCreateWithURL(input as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 256, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary),
          let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw ShareInputError.invalid }
}
