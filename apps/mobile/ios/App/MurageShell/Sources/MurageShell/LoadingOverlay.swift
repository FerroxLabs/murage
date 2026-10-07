#if os(iOS)
import UIKit

/// The splash that stays up until the page says ready (spec §3.1 "Splash"),
/// and the "Still connecting…" panel (§3.2 readiness deadline).
final class LoadingOverlay: UIView {
    var onRetry: (() -> Void)?
    var onChoose: (() -> Void)?
    private let title = LoadingOverlay.label("Connecting to your computer…", style: .headline, color: ShellColors.ink)
    private let body = LoadingOverlay.label("Murage is opening your workspace.", style: .body, color: ShellColors.inkSecondary)
    private var retry: UIButton!
    private let mark = UIImageView(image: UIImage(named: "MurageWordmark"))
    private let panel = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = ShellColors.canvas
        mark.contentMode = .scaleAspectFit
        mark.isAccessibilityElement = true
        mark.accessibilityLabel = "Murage is loading"
        mark.translatesAutoresizingMaskIntoConstraints = false
        addSubview(mark)

        let retry = Self.button("Try again", filled: true) { [weak self] in self?.onRetry?() }
        self.retry = retry
        let reveal = Self.button("Your computers", filled: false) { [weak self] in self?.onChoose?() }
        [title, body, retry, reveal].forEach(panel.addArrangedSubview)
        panel.axis = .vertical
        panel.spacing = 12
        retry.isHidden = true
        panel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(panel)

        NSLayoutConstraint.activate([
            mark.centerXAnchor.constraint(equalTo: centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: centerYAnchor),
            mark.widthAnchor.constraint(equalToConstant: 200),
            mark.heightAnchor.constraint(equalToConstant: 44),
            panel.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 24),
            panel.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -24),
            panel.topAnchor.constraint(equalTo: mark.bottomAnchor, constant: 32),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            reveal.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    required init?(coder: NSCoder) { nil }

    static func label(_ text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = 0
        label.textAlignment = .center
        return label
    }

    static func button(_ title: String, filled: Bool, action: @escaping () -> Void) -> UIButton {
        var config = filled ? UIButton.Configuration.filled() : UIButton.Configuration.plain()
        config.title = title
        config.baseBackgroundColor = ShellColors.accent
        config.baseForegroundColor = filled ? ShellColors.accentInk : ShellColors.accent
        config.cornerStyle = .medium
        return UIButton(configuration: config, primaryAction: UIAction { _ in action() })
    }

    func showSplash() {
        layer.removeAllAnimations()
        alpha = 1
        isHidden = false
        retry.isHidden = true
        title.text = "Connecting to your computer…"
        body.text = "Murage is opening your workspace."
    }

    func showSlow() {
        alpha = 1
        isHidden = false
        retry.isHidden = false
        title.text = "Still connecting…"
        body.text = "You can wait for your workspace or try connecting again."
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    func hide() {
        guard !isHidden else { return }
        UIView.animate(withDuration: 0.2, animations: { self.alpha = 0 }, completion: { finished in
            guard finished else { return } // showSplash() interrupted the fade
            self.isHidden = true
            self.alpha = 1
        })
    }
}

/// A short native note over the page, e.g. basic mode's "Update Murage".
enum Toast {
    static func show(_ text: String, in host: UIView) {
        let label = LoadingOverlay.label(text, style: .footnote, color: ShellColors.ink)
        label.backgroundColor = ShellColors.card
        label.layer.cornerRadius = 12
        label.layer.masksToBounds = true
        label.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            label.bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            label.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        UIAccessibility.post(notification: .announcement, argument: text)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { label.removeFromSuperview() }
    }
}
#endif
