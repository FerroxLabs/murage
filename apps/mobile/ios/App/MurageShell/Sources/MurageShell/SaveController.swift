#if os(iOS)
import MurageShellCore
import UIKit
import WebKit

/// Files for the chunked path: one fresh directory per transfer under tmp,
/// so a name the page chose can never collide with, or reach, anything else.
/// The page's transfer id never becomes part of a path.
///
/// Directories this process made are "live" until removed, and pruning never
/// touches them, so a share sheet left open for a long time keeps its file.
/// Anything else older than `staleAge` is a leftover from an earlier process.
final class FileSink: SaveSink {
    static let root = FileManager.default.temporaryDirectory.appendingPathComponent("murage-saves", isDirectory: true)
    static let staleAge: TimeInterval = 600

    private static let lock = NSLock()
    private static var live: Set<String> = []

    static func freshDirectory() throws -> URL {
        prune()
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        lock.withLock { _ = live.insert(directory.lastPathComponent) }
        return directory
    }

    static func remove(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
        lock.withLock { _ = live.remove(directory.lastPathComponent) }
    }

    /// Deletes subdirectories that are not live and whose newest entry is
    /// older than `staleAge`. A transfer still being written is always live.
    static func prune(now: Date = Date()) {
        let manager = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let entries = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: keys) else { return }
        let cutoff = now.addingTimeInterval(-staleAge)
        let current = lock.withLock { live }
        for directory in entries where !current.contains(directory.lastPathComponent) {
            let inside = (try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []
            let newest = ([directory] + inside)
                .compactMap { try? $0.resourceValues(forKeys: Set(keys)).contentModificationDate }
                .max() ?? .distantPast
            if newest < cutoff { try? manager.removeItem(at: directory) }
        }
    }

    /// Only a plain name directly inside the fresh directory (M1, Android's
    /// CacheSink): anything else removes the directory and is writeFailed.
    func create(id: String, filename: String) throws -> URL {
        let directory = try Self.freshDirectory()
        guard let file = FileNames.contained(filename, in: directory) else {
            Self.remove(directory)
            throw ChannelError.writeFailed
        }
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else {
            Self.remove(directory)
            throw CocoaError(.fileWriteUnknown)
        }
        return file
    }

    func append(_ data: Data, to file: URL) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    func discard(_ file: URL) {
        Self.remove(file.deletingLastPathComponent())
    }
}

/// `saveFile` (spec §3.2; src/lib/save-file.ts) and every WKDownload the page
/// starts. Finished files go to the share sheet (Decision 8) and are deleted
/// a minute after it closes (a share extension may still be reading them).
/// Every HTTP hop of a download stays on the workspace origin.
@MainActor
final class SaveController: NSObject, WKDownloadDelegate {
    typealias Reply = (Any?, String?) -> Void

    static let shareGrace: TimeInterval = 60
    /// A share sheet UIKit has not put up by then never will be (M9).
    static let presentTimeout: TimeInterval = 2

    /// Files a crashed or killed process left behind, from each workspace
    /// screen's viewDidLoad. Only stale, non-live directories go.
    static func sweepLeftovers() {
        FileSink.prune()
    }

    private let origin: WorkspaceOrigin
    private weak var host: UIViewController?
    private let isClosing: () -> Bool
    private lazy var assembler = ChunkAssembler(sink: FileSink())
    private var openTransfers: Set<String> = []
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var replies: [ObjectIdentifier: Reply] = [:]
    private var names: [ObjectIdentifier: String] = [:]
    private var destinations: [ObjectIdentifier: URL] = [:]

    init(origin: WorkspaceOrigin, host: UIViewController, isClosing: @escaping () -> Bool) {
        self.origin = origin
        self.host = host
        self.isClosing = isClosing
    }

    /// The screen is closing: stop every download, delete what they wrote,
    /// and drop every open chunked transfer. Pending pages get `unavailable`.
    func cancelAll() {
        let cancelled = downloads.count + openTransfers.count
        if cancelled > 0 { ShellLog.value("saves cancelled transfers", cancelled) }
        for (key, download) in downloads {
            download.cancel { _ in }
            if let destination = destinations.removeValue(forKey: key) { FileSink.remove(destination.deletingLastPathComponent()) }
            finish(key, error: .unavailable)
        }
        downloads.removeAll()
        for id in openTransfers { assembler.abort(id: id) }
        openTransfers.removeAll()
    }

    /// Every path replies exactly once.
    func handle(_ args: [String: Any], in webView: WKWebView, reply: @escaping Reply) {
        switch SaveRequest.parse(args, origin: origin) {
        case .failure(let error):
            reply(nil, error.rawValue)
        case .success(.url(let url, let filename)):
            // The workspace WebView's own store and cookies; the same-origin
            // rule is SaveRequest's (foreign_url), not re-derived here.
            webView.startDownload(using: URLRequest(url: url)) { [weak self] download in
                MainActor.assumeIsolated {
                    guard let self else {
                        download.cancel { _ in }
                        reply(nil, ChannelError.unavailable.rawValue)
                        return
                    }
                    let key = ObjectIdentifier(download)
                    self.downloads[key] = download
                    self.replies[key] = reply
                    self.names[key] = filename
                    download.delegate = self
                }
            }
        case .success(.begin(let id, let filename, let mime, let size)):
            run(reply) {
                try self.assembler.begin(id: id, filename: filename, mime: mime, size: size)
                self.openTransfers.insert(id)
            }
        case .success(.chunk(let id, let index, let base64)):
            run(reply) { try self.assembler.chunk(id: id, index: index, base64: base64) }
        case .success(.end(let id)):
            do {
                let file = try assembler.end(id: id)
                openTransfers.remove(id)
                ShellLog.value("save blob bytes", file.size)
                share(file.file) { error in
                    if let error { reply(nil, error.rawValue) } else { reply(["saved": true, "bytes": file.size], nil) }
                }
            } catch {
                reply(nil, (error as? ChannelError ?? .writeFailed).rawValue)
            }
        case .success(.abort(let id)):
            assembler.abort(id: id)
            openTransfers.remove(id)
            reply(["ok": true], nil)
        }
    }

    private func run(_ reply: Reply, _ body: () throws -> Void) {
        do {
            try body()
            reply(["ok": true], nil)
        } catch {
            reply(nil, (error as? ChannelError ?? .writeFailed).rawValue)
        }
    }

    /// A navigation or `a[download]` that WebKit turned into a download
    /// (Phase 0: an iOS `blob:` `a[download]` arrives here). No page reply.
    func adopt(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    // MARK: WKDownloadDelegate

    /// No redirect off the workspace origin: the WebView's cookie went with
    /// the first request, and the file must come from the user's own server.
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let url = request.url, origin.contains(url) else {
            ShellLog.event("save redirect refused")
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let key = ObjectIdentifier(download)
        // blob: and data: responses are not HTTP and stay allowed.
        if let http = response as? HTTPURLResponse {
            guard let url = http.url, origin.contains(url) else {
                ShellLog.event("save foreign refused")
                finish(key, error: .foreignURL)
                completionHandler(nil)
                return
            }
        }
        let status = (response as? HTTPURLResponse)?.statusCode
        guard DownloadGate.accept(status: status) else {
            ShellLog.event("save refused", status: status ?? -1)
            finish(key, error: .downloadFailed)
            completionHandler(nil)
            return
        }
        do {
            let directory = try FileSink.freshDirectory()
            guard let destination = FileNames.contained(FileNames.safe(names[key] ?? suggestedFilename), in: directory) else {
                FileSink.remove(directory)
                finish(key, error: .writeFailed)
                completionHandler(nil)
                return
            }
            destinations[key] = destination
            completionHandler(destination)
        } catch {
            finish(key, error: .writeFailed)
            completionHandler(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        guard let destination = destinations.removeValue(forKey: key) else { finish(key, error: .downloadFailed); return }
        let bytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
        ShellLog.value("save download bytes", bytes)
        share(destination) { error in
            if let error { self.finish(key, error: error) } else { self.finish(key, result: ["saved": true]) }
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        if let destination = destinations.removeValue(forKey: key) { FileSink.remove(destination.deletingLastPathComponent()) }
        finish(key, error: .downloadFailed)
    }

    private func finish(_ key: ObjectIdentifier, result: Any? = nil, error: ChannelError? = nil) {
        names[key] = nil
        downloads[key] = nil
        guard let reply = replies.removeValue(forKey: key) else { return }
        if let error { reply(nil, error.rawValue) } else { reply(result, nil) }
    }

    /// `done(nil)` once the sheet is up, exactly once. With the screen gone
    /// or closing, another panel showing or the screen mid-transition, the
    /// file is deleted and `done` gets the refusal. UIKit silently refuses a
    /// present during a transition and never calls back, so a sheet that is
    /// not up after `presentTimeout` is answered `unavailable` (M9).
    private func share(_ file: URL, done: @escaping (ChannelError?) -> Void) {
        let directory = file.deletingLastPathComponent()
        guard let host, host.viewIfLoaded?.window != nil, !isClosing() else {
            FileSink.remove(directory)
            done(.unavailable)
            return
        }
        guard host.presentedViewController == nil,
              !(host.isBeingDismissed || host.isBeingPresented || host.transitionCoordinator != nil) else {
            FileSink.remove(directory)
            done(.busy)
            return
        }
        let once = AnswerOnce()
        let answer: (ChannelError?) -> Void = { error in
            guard !once.answered else { return }
            once.answered = true
            done(error)
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = host.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 1, width: 1, height: 1)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.shareGrace) { FileSink.remove(directory) }
        }
        host.present(sheet, animated: true) { answer(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.presentTimeout) { [weak sheet] in
            MainActor.assumeIsolated {
                guard !once.answered else { return }
                if sheet?.presentingViewController == nil {
                    ShellLog.event("share sheet never came up")
                    FileSink.remove(directory)
                    answer(.unavailable)
                } else {
                    answer(nil) // up, only its completion is late
                }
            }
        }
    }
}

/// share()'s one answer, shared by the present completion and the timeout.
private final class AnswerOnce {
    var answered = false
}
#endif
