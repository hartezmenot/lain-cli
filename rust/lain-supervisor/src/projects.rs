//! WHICH PROJECTS THIS MACHINE HAS SEEN, AND WHEN IT LAST LOOKED.
//!
//! ------------------------------------------------------------------------
//! TWO STATE DOMAINS, AND THIS FILE IS THE SMALLER ONE ON PURPOSE.
//!
//!     ~/.lain-v2/supervisor/projects/    THIS FILE
//!         identity, and when the runtime last synchronised with a tree.
//!         COUNTS and a digest. Nothing else.
//!
//!     <project>/.lain/                   projectindex.js
//!         the materialised intelligence: symbols, imports, fingerprints,
//!         per file. It lives WITH the project because it describes the
//!         project, and because a checkout somebody clones has no business
//!         carrying another machine's home directory around.
//!
//! THE RULE THIS FILE EXISTS TO KEEP: the project index is not duplicated
//! here. There is no symbol table, no import graph and no per-file record
//! below — a second copy of those is a second authority, and on the day the two
//! disagreed there would be no way to say which was right. What is here is the
//! bookkeeping needed to answer ONE question without walking anything:
//!
//!     have I seen this tree before, and has it moved since?
//!
//! ------------------------------------------------------------------------
//! WHY THE RUNTIME OWNS THIS RATHER THAN THE CLI.
//!
//! The answer has to survive the process that computed it. A CLI that opens a
//! project, indexes it and then exits has learned something no session file
//! records; the next CLI would rediscover it. This process was running before
//! either of them and will be running after, which is the same argument that
//! put jobs and provider health here.
//!
//! IT NEVER READS THE PROJECT. Not one file, not one `stat`. It is told what a
//! worker found and it remembers; deciding what changed is the worker's job,
//! because the worker is the thing holding the tree open.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

use crate::json::{self, Value};

/// What the runtime remembers about one tree. COUNTS AND A DIGEST — see the
/// header for why there is nothing per-file here.
#[derive(Debug, Clone)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub first_seen: u64,
    pub last_sync: u64,
    /// The index shape the worker used, so a changed shape forces a rebuild
    /// rather than being read with the wrong meaning.
    pub index_version: u64,
    pub files: u64,
    pub symbols: u64,
    /// A summary of the tree as of the last sync. Compared, never interpreted.
    pub digest: String,
    /// `full`, `incremental`, or `unchanged` — what the last sync actually did.
    pub last_result: String,
}

impl Project {
    fn new(id: &str, path: &str, name: &str) -> Project {
        Project {
            id: id.to_string(),
            path: path.to_string(),
            name: name.to_string(),
            first_seen: now(),
            last_sync: 0,
            index_version: 0,
            files: 0,
            symbols: 0,
            digest: String::new(),
            last_result: String::new(),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut v = Value::obj();
        v.set("id", Value::s(&self.id));
        v.set("path", Value::s(&self.path));
        v.set("name", Value::s(&self.name));
        v.set("first_seen", Value::n(self.first_seen as i64));
        v.set("last_sync", Value::n(self.last_sync as i64));
        v.set("index_version", Value::n(self.index_version as i64));
        v.set("files", Value::n(self.files as i64));
        v.set("symbols", Value::n(self.symbols as i64));
        v.set("digest", Value::s(&self.digest));
        v.set("last_result", Value::s(&self.last_result));
        v
    }

    fn from_value(v: &Value) -> Option<Project> {
        let id = v.str("id");
        if id.is_empty() {
            return None;
        }
        let n = |k: &str| v.num(k).unwrap_or(0.0).max(0.0) as u64;
        Some(Project {
            id,
            path: v.str("path"),
            name: v.str("name"),
            first_seen: n("first_seen"),
            last_sync: n("last_sync"),
            index_version: n("index_version"),
            files: n("files"),
            symbols: n("symbols"),
            digest: v.str("digest"),
            last_result: v.str("last_result"),
        })
    }
}

pub fn now() -> u64 {
    crate::jobs::now()
}

pub struct Projects {
    dir: PathBuf,
    pub known: BTreeMap<String, Project>,
}

/// A STABLE ID FOR A PATH, without a hash crate.
///
/// FNV-1a over the normalised path. It is an identifier, not a security
/// primitive: it has to be the same on every run for the same directory and
/// different for different ones, and that is all that is asked of it.
///
/// NORMALISED FIRST, so `C:\Proj` and `c:/proj/` are one project rather than
/// three. On Windows that means case-folding; a path is not case-sensitive
/// there and treating it as if it were would give one tree several identities.
pub fn id_for(path: &str) -> String {
    let norm: String = path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in norm.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The last segment of a path, which is what people call their projects.
fn name_of(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

impl Projects {
    pub fn open(dir: PathBuf) -> Projects {
        let mut p = Projects { dir, known: BTreeMap::new() };
        let _ = fs::create_dir_all(p.store_dir());
        p.load();
        p
    }

    fn store_dir(&self) -> PathBuf {
        self.dir.join("projects")
    }

    fn load(&mut self) {
        let d = self.store_dir();
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let mut s = String::new();
            if fs::File::open(&p).and_then(|mut f| f.read_to_string(&mut s)).is_err() {
                continue;
            }
            // A record that does not parse is skipped, never fatal: one bad
            // project must not hide the others.
            if let Some(pr) = json::parse(&s).as_ref().and_then(Project::from_value) {
                self.known.insert(pr.id.clone(), pr);
            }
        }
    }

    fn persist(&self, id: &str) {
        let pr = match self.known.get(id) {
            Some(p) => p,
            None => return,
        };
        let d = self.store_dir();
        let _ = fs::create_dir_all(&d);
        let tmp = d.join(format!("{id}.tmp"));
        if fs::write(&tmp, json::write(&pr.to_value()).as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, d.join(format!("{id}.json")));
        }
    }

    /// ------------------------------------------------------------------------
    /// OPENING A PROJECT: what does the runtime already know?
    ///
    /// Answers WITHOUT TOUCHING THE TREE. The caller supplies the digest its
    /// worker computed; this says whether that matches what was recorded, which
    /// is the whole of the synchronisation decision:
    ///
    ///     NEW          never seen. Everything must be indexed.
    ///     UNCHANGED    same digest, same index shape. Nothing to do.
    ///     MODIFIED     seen, and it has moved. Update what changed.
    ///     RESHAPED     the index format changed under it. Rebuild.
    ///
    /// A caller that passes no digest gets `NEW` or `MODIFIED` and never
    /// `UNCHANGED` — refusing to claim a tree is unchanged on no evidence is
    /// the same rule `reset_at: null` follows in providers.rs.
    pub fn open_project(&mut self, path: &str, digest: &str, index_version: u64) -> (String, Project) {
        let id = id_for(path);
        let known = self.known.get(&id).cloned();
        let verdict = match &known {
            None => "NEW",
            Some(p) if p.last_sync == 0 => "NEW",
            Some(p) if p.index_version != index_version && index_version > 0 => "RESHAPED",
            Some(p) if !digest.is_empty() && p.digest == digest => "UNCHANGED",
            Some(_) => "MODIFIED",
        };
        let entry = self
            .known
            .entry(id.clone())
            .or_insert_with(|| Project::new(&id, path, &name_of(path)));
        // The path is refreshed on every open: a project that moved on disk is
        // the same project, and the stale path would be the one thing here that
        // could send somebody to the wrong directory.
        entry.path = path.to_string();
        entry.name = name_of(path);
        let out = entry.clone();
        self.persist(&id);
        (verdict.to_string(), out)
    }

    /// A WORKER FINISHED SYNCHRONISING. This is the only way `digest` moves.
    ///
    /// Counts and a digest, never the index — see the header. `result` is what
    /// the worker actually did, kept so a person reading this can tell a tree
    /// that was rebuilt from one that was merely confirmed.
    pub fn synced(
        &mut self,
        path: &str,
        digest: &str,
        index_version: u64,
        files: u64,
        symbols: u64,
        result: &str,
    ) -> Project {
        let id = id_for(path);
        let entry = self
            .known
            .entry(id.clone())
            .or_insert_with(|| Project::new(&id, path, &name_of(path)));
        entry.path = path.to_string();
        entry.name = name_of(path);
        entry.last_sync = now();
        entry.digest = digest.to_string();
        entry.index_version = index_version;
        entry.files = files;
        entry.symbols = symbols;
        entry.last_result = result.chars().take(24).collect();
        let out = entry.clone();
        self.persist(&id);
        out
    }

    pub fn get(&self, path: &str) -> Option<&Project> {
        self.known.get(&id_for(path))
    }

    pub fn all(&self) -> Vec<Value> {
        self.known.values().map(Project::to_value).collect()
    }

    /// A project somebody deleted, or one recorded by mistake.
    pub fn forget(&mut self, path: &str) -> bool {
        let id = id_for(path);
        let existed = self.known.remove(&id).is_some();
        let _ = fs::remove_file(self.store_dir().join(format!("{id}.json")));
        existed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> Projects {
        let d = std::env::temp_dir().join(format!("lain-projects-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        Projects::open(d)
    }

    #[test]
    fn one_directory_has_one_identity_however_it_is_written() {
        // A project reached by a different spelling of the same path is the
        // same project. Three identities for one tree would mean three indexes
        // and three answers to "have I seen this before".
        let a = id_for("C:\\Users\\me\\Proj");
        let b = id_for("c:/users/me/proj/");
        let c = id_for("C:/Users/me/Proj");
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, id_for("C:/Users/me/Other"));
    }

    #[test]
    fn a_tree_never_seen_is_new_and_a_synced_one_is_not() {
        let mut p = store("new");
        let (verdict, _) = p.open_project("/tmp/proj", "", 1);
        assert_eq!(verdict, "NEW");
        p.synced("/tmp/proj", "d1", 1, 10, 100, "full");
        let (again, pr) = p.open_project("/tmp/proj", "d1", 1);
        assert_eq!(again, "UNCHANGED");
        assert_eq!(pr.files, 10);
        assert_eq!(pr.symbols, 100);
        assert_eq!(pr.last_result, "full");
    }

    #[test]
    fn a_moved_tree_is_modified_and_a_changed_index_shape_is_reshaped() {
        let mut p = store("moved");
        p.synced("/tmp/proj", "d1", 1, 10, 100, "full");
        assert_eq!(p.open_project("/tmp/proj", "d2", 1).0, "MODIFIED");
        // The index format changed under it: what is on disk may be readable
        // but no longer means what this version thinks it means.
        assert_eq!(p.open_project("/tmp/proj", "d1", 2).0, "RESHAPED");
    }

    #[test]
    fn nothing_is_called_unchanged_without_evidence_for_it() {
        // No digest is not agreement. Answering UNCHANGED here would skip a
        // sync on no grounds at all.
        let mut p = store("noevidence");
        p.synced("/tmp/proj", "d1", 1, 10, 100, "full");
        assert_eq!(p.open_project("/tmp/proj", "", 1).0, "MODIFIED");
    }

    #[test]
    fn two_projects_never_share_state() {
        let mut p = store("two");
        p.synced("/tmp/a", "da", 1, 1, 2, "full");
        p.synced("/tmp/b", "db", 1, 3, 4, "full");
        assert_eq!(p.get("/tmp/a").unwrap().files, 1);
        assert_eq!(p.get("/tmp/b").unwrap().files, 3);
        assert_eq!(p.open_project("/tmp/a", "da", 1).0, "UNCHANGED");
        assert_eq!(p.open_project("/tmp/b", "da", 1).0, "MODIFIED");
    }

    #[test]
    fn what_it_remembers_survives_a_restart_and_is_only_bookkeeping() {
        let mut p = store("restart");
        p.synced("/tmp/proj", "d1", 1, 42, 900, "incremental");
        let dir = p.store_dir().parent().unwrap().to_path_buf();
        let again = Projects::open(dir);
        let pr = again.get("/tmp/proj").expect("the record survived");
        assert_eq!(pr.digest, "d1");
        assert_eq!(pr.files, 42);
        // ---- AND IT IS NOT A SECOND PROJECT INDEX -------------------------
        //
        // Counts and a digest. A symbol table here would be a duplicate of
        // <project>/.lain and a second authority for the same truth.
        let text = json::write(&pr.to_value());
        for leaked in ["symbols\":[", "imports", "files\":[", "mtime"] {
            assert!(!text.contains(leaked), "the runtime record is carrying index data: {leaked}");
        }
    }

    #[test]
    fn a_project_can_be_forgotten() {
        let mut p = store("forget");
        p.synced("/tmp/proj", "d1", 1, 1, 1, "full");
        assert!(p.forget("/tmp/proj"));
        assert!(!p.forget("/tmp/proj"));
        assert_eq!(p.open_project("/tmp/proj", "d1", 1).0, "NEW");
    }
}
