import SwiftUI

/// Settings > Games: the "Share game statistics" switch and every game this Mac has recorded
/// sessions of (GameStatsStore), each with its numbers, the player's optional rating and its own
/// sharing switch.
struct GamesTab: View {
    @EnvironmentObject var settings: LauncherSettings
    @ObservedObject var store = GameStatsStore.shared
    @State private var showWhatIsSent = false

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $settings.shareGameStats) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Share game statistics")
                        Text(verbatim: GameStatsText.summary)
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Text("applies now").font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Button("What Is Sent…") { showWhatIsSent = true }
                        .popover(isPresented: $showWhatIsSent, arrowEdge: .bottom) { GameStatsWhatIsSent() }
                    Spacer()
                    Link("Open Statistics Page", destination: GameStatsStore.pageURL)
                }
                if !store.status.isEmpty {
                    Text(verbatim: store.status).font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                if store.games.isEmpty {
                    Text("Games appear here after you play them in SteamOS.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.games) { g in GameStatsRow(game: g, store: store, sharingOn: settings.shareGameStats) }
                }
            } header: {
                Text("Games")
            } footer: {
                Text("Ratings are optional and shared with the statistics. A game with Share off is kept only on this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct GameStatsWhatIsSent: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(GameStatsText.whatIsSent, id: \.self) { line in
                Text(verbatim: "• " + line).fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.callout)
        .padding(14)
        .frame(width: 380, alignment: .leading)
    }
}

private struct GameStatsRow: View {
    let game: GameStatsStore.Game
    let store: GameStatsStore
    let sharingOn: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: game.title)
                Text(verbatim: totals).font(.caption).foregroundStyle(.secondary)
                if let last = lastSession { Text(verbatim: last).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            Picker(selection: Binding(get: { game.rating }, set: { store.setRating($0, for: game.appid) })) {
                Text("Not rated").tag(GameRating?.none)
                ForEach(GameRating.allCases) { r in Text(verbatim: r.title).tag(GameRating?.some(r)) }
            } label: {
                EmptyView()
            }
            .labelsHidden()
            .fixedSize()
            Toggle("Share", isOn: Binding(get: { game.sharing }, set: { store.setSharing($0, for: game.appid) }))
                .toggleStyle(.checkbox)
                .help(sharingOn ? String(localized: "Send this game's sessions and rating")
                      : String(localized: "Turn on Share game statistics above to send anything"))
        }
    }

    /// "Sessions: 3 · 4 h 12 min · last played 22 Oct 2026 · App ID 1091500"
    private var totals: String {
        var parts = [String(localized: "Sessions: \(game.totalSessions)")]
        if game.totalPlayS >= 60 {
            parts.append(Duration.seconds(game.totalPlayS).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
        }
        if let d = game.lastPlayed { parts.append(String(localized: "last played \(d.formatted(date: .abbreviated, time: .omitted))")) }
        parts.append(String(localized: "App ID \(String(game.appid))"))
        return parts.joined(separator: " · ")
    }

    /// The newest session: "Last session: 54 FPS (1% low 31) · 5.4 GB game memory · KosmicKrisp", or
    /// "Last session: no window appeared" for a launch that never showed.
    private var lastSession: String? {
        guard let r = game.sessions.first?.report else { return nil }
        guard r.launched else { return String(localized: "Last session: no window appeared") }
        var parts: [String] = []
        if let f = r.fps {
            parts.append(String(localized: "\(Int(f.avg.rounded())) FPS (1% low \(Int(f.low1.rounded())))"))
        }
        if let mib = r.mem?.gameMiB {
            parts.append(String(localized: "\(ByteCountFormatter.string(fromByteCount: Int64(mib) << 20, countStyle: .memory)) game memory"))
        }
        parts.append(LauncherSettings.VulkanDriver(rawValue: r.vm.driver)?.name ?? r.vm.driver)
        return String(localized: "Last session: \(parts.joined(separator: " · "))")
    }
}
