//! 07 §2.1 notes + local store, plus the 03-sync amendment commands.

use crate::app::events;
use crate::app::state::{AppState, SyncStatus};
use crate::app::{tray, windows};
use crate::db::{checklist, notes, sync_state, versions};
use crate::error::{IpcError, IpcResult};
use crate::model::{
    NoteDocBundle, NoteListItem, NoteProjection, NoteRecord, PendingSync, SearchFilters,
    SyncErrorItem, TodoCounts, TodoItem, UpdatesSince, VersionItem, WindowState,
};
use crate::util::{b64_decode, b64_encode};
use tauri::{AppHandle, Manager, State};

const ORIGINS: [&str; 4] = ["local", "remote", "import", "ai"];

fn check_origin(origin: &str) -> IpcResult<()> {
    if ORIGINS.contains(&origin) {
        Ok(())
    } else {
        Err(IpcError::invalid(format!("unknown origin {origin}")))
    }
}

#[tauri::command]
pub fn notes_list(
    state: State<'_, AppState>,
    include_trashed: Option<bool>,
    workspace_id: Option<String>,
) -> IpcResult<Vec<NoteListItem>> {
    state.with_db(|c| {
        notes::list(
            c,
            include_trashed.unwrap_or(false),
            workspace_id.as_deref().map(Some),
        )
    })
}

#[tauri::command]
pub fn notes_search(
    state: State<'_, AppState>,
    q: String,
    bigram_query: Option<String>,
    include_trashed: Option<bool>,
    limit: Option<i64>,
    filters: Option<SearchFilters>,
) -> IpcResult<Vec<NoteListItem>> {
    state.with_db(|c| {
        notes::search(
            c,
            &q,
            bigram_query.as_deref(),
            include_trashed.unwrap_or(false),
            limit.unwrap_or(200),
            &filters.unwrap_or_default(),
        )
    })
}

#[tauri::command]
pub fn note_get(state: State<'_, AppState>, note_id: String) -> IpcResult<NoteRecord> {
    state.with_db(|c| notes::get(c, &note_id))
}

#[tauri::command]
pub fn note_create(
    app: AppHandle,
    note_id: String,
    update_v2_b64: String,
    projection: NoteProjection,
    workspace_id: Option<String>,
    import_source: Option<String>,
    import_external_id: Option<String>,
) -> IpcResult<NoteRecord> {
    let update = b64_decode(&update_v2_b64)?;
    let origin = if import_source.is_some() {
        "import"
    } else {
        "local"
    };
    let has_window = windows::note_window(&app, &note_id).is_some();
    let rec = events::mutate(
        &app,
        origin,
        &[
            "notes",
            "ydoc_updates",
            "note_window_state",
            "checklist_items",
        ],
        vec![note_id.clone()],
        |tx| {
            let rec = notes::create(
                tx,
                &note_id,
                &update,
                &projection,
                workspace_id.as_deref(),
                import_source.as_deref(),
                import_external_id.as_deref(),
                origin,
            )?;
            if has_window {
                crate::db::window_state::set_is_open(tx, &note_id, true)?;
                if projection.z_mode != 0 {
                    crate::db::window_state::set_z_mode(tx, &note_id, projection.z_mode)?;
                }
            }
            Ok(rec)
        },
    )?;
    if has_window {
        let _ = windows::set_color(&app, &note_id, projection.color);
    }
    Ok(rec)
}

#[tauri::command]
pub fn note_load_doc(state: State<'_, AppState>, note_id: String) -> IpcResult<NoteDocBundle> {
    state.with_db(|c| notes::load_doc(c, &note_id))
}

#[tauri::command]
pub fn note_append_update(
    app: AppHandle,
    note_id: String,
    update_v2_b64: String,
    origin: String,
    projection: Option<NoteProjection>,
) -> IpcResult<serde_json::Value> {
    check_origin(&origin)?;
    let update = b64_decode(&update_v2_b64)?;
    let tables: &[&str] = if projection.is_some() {
        &["ydoc_updates", "notes", "checklist_items"]
    } else {
        &["ydoc_updates"]
    };
    let seq = events::mutate(&app, &origin, tables, vec![note_id.clone()], |tx| {
        notes::append_update(tx, &note_id, &update, &origin, projection.as_ref())
    })?;
    if let Some(p) = &projection {
        if windows::note_window(&app, &note_id).is_some() {
            let _ = windows::set_color(&app, &note_id, p.color);
        }
    }
    Ok(serde_json::json!({ "seq": seq }))
}

#[tauri::command]
pub fn note_updates_since(
    state: State<'_, AppState>,
    note_id: String,
    after_seq: i64,
) -> IpcResult<UpdatesSince> {
    state.with_db(|c| notes::updates_since(c, &note_id, after_seq))
}

#[tauri::command]
pub fn note_write_snapshot(
    state: State<'_, AppState>,
    note_id: String,
    state_v2_b64: String,
    sv_b64: String,
    upto_seq: i64,
) -> IpcResult<()> {
    let st = b64_decode(&state_v2_b64)?;
    let sv = b64_decode(&sv_b64)?;
    state.with_tx(|tx| notes::write_snapshot(tx, &note_id, &st, &sv, upto_seq))
}

#[tauri::command]
pub fn note_compact(state: State<'_, AppState>, note_id: String) -> IpcResult<serde_json::Value> {
    let upto = state.with_tx(|tx| notes::compact(tx, &note_id))?;
    Ok(serde_json::json!({ "uptoSeq": upto }))
}

#[tauri::command]
pub fn note_discard_if_empty(app: AppHandle, note_id: String) -> IpcResult<serde_json::Value> {
    let state = app.state::<AppState>();
    let discarded = state.with_tx(|tx| notes::discard_if_empty(tx, &note_id))?;
    if discarded {
        let rev = state.with_tx(|tx| Ok(crate::db::bump_rev(tx)?))?;
        events::emit(
            &app,
            events::DB_CHANGED,
            crate::model::DbChanged {
                rev,
                origin: "local".into(),
                tables: vec![
                    "notes".into(),
                    "note_window_state".into(),
                    "checklist_items".into(),
                ],
                ids: vec![note_id.clone()],
            },
        );
    }
    Ok(serde_json::json!({ "discarded": discarded }))
}

#[tauri::command]
pub fn note_set_synced(app: AppHandle, note_id: String, head_seq: i64) -> IpcResult<()> {
    events::mutate(
        &app,
        "system",
        &["sync_state", "notes"],
        vec![note_id.clone()],
        |tx| notes::set_synced(tx, &note_id, head_seq),
    )
}

#[tauri::command]
pub fn notes_pending_sync(state: State<'_, AppState>) -> IpcResult<Vec<PendingSync>> {
    state.with_db(notes::pending_sync)
}

#[tauri::command]
pub fn trash_empty(app: AppHandle) -> IpcResult<serde_json::Value> {
    let purged = events::mutate(&app, "local", &["notes", "checklist_items"], vec![], |tx| {
        notes::trash_empty(tx)
    })?;
    Ok(serde_json::json!({ "purged": purged }))
}

#[tauri::command]
pub fn notes_purge_expired(app: AppHandle) -> IpcResult<serde_json::Value> {
    let purged = events::mutate(
        &app,
        "system",
        &["notes", "checklist_items"],
        vec![],
        |tx| notes::purge_expired(tx),
    )?;
    Ok(serde_json::json!({ "purged": purged }))
}

/// Extra (not in 07): todos page. Open items first, then most recently edited note first, then
/// document order; trashed / purged notes excluded. `workspace_id = None` = every local note.
#[tauri::command]
pub fn todos_list(
    state: State<'_, AppState>,
    include_done: Option<bool>,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> IpcResult<Vec<TodoItem>> {
    state.with_db(|c| {
        checklist::list(
            c,
            include_done.unwrap_or(false),
            workspace_id.as_deref(),
            limit,
        )
    })
}

/// Extra (not in 07): `{ open, done }` with the same exclusions as `todos_list`.
#[tauri::command]
pub fn todos_counts(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
) -> IpcResult<TodoCounts> {
    state.with_db(|c| checklist::counts(c, workspace_id.as_deref()))
}

#[tauri::command]
pub fn note_version_save(
    state: State<'_, AppState>,
    note_id: String,
    state_v2_b64: String,
    label: String,
) -> IpcResult<serde_json::Value> {
    let bytes = b64_decode(&state_v2_b64)?;
    let id = state.with_tx(|tx| {
        if !notes::exists(tx, &note_id)? {
            return Err(IpcError::not_found(format!("note {note_id} not found")));
        }
        let id = versions::save(tx, &note_id, &bytes, &label)?;
        versions::prune(tx)?;
        Ok(id)
    })?;
    Ok(serde_json::json!({ "id": id }))
}

#[tauri::command]
pub fn note_versions_list(
    state: State<'_, AppState>,
    note_id: String,
) -> IpcResult<Vec<VersionItem>> {
    state.with_db(|c| versions::list(c, &note_id))
}

#[tauri::command]
pub fn note_version_get(state: State<'_, AppState>, id: String) -> IpcResult<serde_json::Value> {
    let bytes = state.with_db(|c| versions::get(c, &id))?;
    Ok(serde_json::json!({ "stateV2B64": b64_encode(&bytes) }))
}

#[tauri::command]
pub fn sync_state_set_error(
    app: AppHandle,
    note_id: String,
    err_code: Option<String>,
    message: Option<String>,
) -> IpcResult<()> {
    events::mutate(
        &app,
        "system",
        &["sync_state"],
        vec![note_id.clone()],
        |tx| sync_state::set_error(tx, &note_id, err_code.as_deref(), message.as_deref()),
    )
}

#[tauri::command]
pub fn sync_errors_list(state: State<'_, AppState>) -> IpcResult<Vec<SyncErrorItem>> {
    state.with_db(sync_state::errors)
}

/// Extra (not in 07): the sync host reports its status so Rust can update the tray.
/// (`sync:status` events emitted from JS are also picked up — see `app::setup`.)
#[tauri::command]
pub fn sync_status_report(
    app: AppHandle,
    state: String,
    at: Option<i64>,
    detail: Option<String>,
) -> IpcResult<()> {
    tray::set_sync_status(
        &app,
        SyncStatus {
            state,
            at: at.unwrap_or_else(crate::util::now_ms),
            detail,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn window_state_get(
    state: State<'_, AppState>,
    note_id: String,
) -> IpcResult<Option<WindowState>> {
    state.with_db(|c| crate::db::window_state::get(c, &note_id))
}
