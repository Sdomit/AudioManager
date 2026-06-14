fn main() {
    ensure_phone_dist();
    tauri_build::build()
}

/// rust-embed requires its folder to exist at macro-expansion time. The real
/// phone client is produced by `pnpm build:phone` (vite.phone.config.ts ->
/// ../dist-phone); on a fresh checkout or plain `cargo check` we create the
/// folder with a placeholder page so the crate always compiles.
fn ensure_phone_dist() {
    let dir = std::path::Path::new("../dist-phone");
    let index = dir.join("phone.html");
    if !index.exists() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(
            &index,
            "<!doctype html><html><body><p>Phone client not built. Run `pnpm build:phone`.</p></body></html>",
        );
    }
}
