import SwiftUI

struct StatusBadgeView: View {
    let status: SessionStatus

    var body: some View {
        Text(status.label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(statusColor)
            .background(statusColor.opacity(0.14), in: Capsule())
    }

    private var statusColor: Color {
        switch status {
        case .running:
            return .green
        case .needsInput:
            return .orange
        case .blocked:
            return .red
        case .done:
            return .blue
        case .failed:
            return .red
        case .idle:
            return .secondary
        }
    }
}
