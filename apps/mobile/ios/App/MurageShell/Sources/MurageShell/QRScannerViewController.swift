#if os(iOS)
import AVFoundation
import MurageShellCore
import UIKit

/// The pairing QR scanner (spec §3.1, carried over from the Codex branch).
/// It answers exactly once: the first code that, trimmed of whitespace and
/// newlines, is a pairing link the core parses, `.cancelled` when the person leaves, `.unavailable` when the
/// camera cannot start. Any other code is ignored and scanning goes on.
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "murage.qr.capture")
    private let result: (Result<String, ScanFailure>) -> Void
    private var preview: AVCaptureVideoPreviewLayer?
    private var completed = false
    private var cameraFailed = false

    init(result: @escaping (Result<String, ScanFailure>) -> Void) {
        self.result = result
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let cancel = LoadingOverlay.button("Cancel", filled: true) { [weak self] in self?.finish(.failure(.cancelled)) }
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)
        NSLayoutConstraint.activate([
            cancel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), capture.canAddInput(input) else {
            // Answered once the presentation has finished (viewDidAppear):
            // a dismiss while it is still running can drop its completion.
            cameraFailed = true
            return
        }
        capture.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard capture.canAddOutput(output) else { cameraFailed = true; return }
        capture.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: capture)
        layer.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(layer, at: 0)
        preview = layer

        let hint = LoadingOverlay.label("On your computer, open Murage, then Settings, then Phone and other devices. Point your camera at the code.", style: .body, color: .white)
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)
        NSLayoutConstraint.activate([
            hint.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            hint.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
        queue.async { [capture] in capture.startRunning() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if cameraFailed { finish(.failure(.unavailable)) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    /// Dismissed some other way (a swipe, the launcher going away): still one answer.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        queue.async { [capture] in capture.stopRunning() }
        if !completed {
            completed = true
            result(.failure(.cancelled))
        }
    }

    private func finish(_ value: Result<String, ScanFailure>) {
        guard !completed else { return }
        completed = true
        queue.async { [capture] in capture.stopRunning() }
        if presentingViewController != nil {
            dismiss(animated: true) { self.result(value) }
        } else {
            result(value)
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        for object in metadataObjects {
            // Trimmed like the launcher's typed input and Android's scanner (P21 fix round 1).
            guard let code = object as? AVMetadataMachineReadableCodeObject,
                  let value = code.stringValue.map(WorkspaceOrigin.trimInput),
                  PairingLink.parse(value) != nil else { continue }
            finish(.success(value))
            return
        }
    }
}
#endif
