"""Offline migration to one Zero config entry; rule storage and identities stay intact."""
import json
from pathlib import Path
import shutil


def load_credentials(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text()) or {}
    except json.JSONDecodeError:
        import yaml
        return yaml.safe_load(path.read_text()) or {}


def migrate(root, files, settings_token, backup_name, apply=True):
    root = Path(root)
    config = (root / "configuration.yaml").read_text()
    for line in config.splitlines():
        if line.startswith("assistant_rules:") and line.strip() != "assistant_rules: !include assistant_rules_credentials.yaml":
            raise ValueError("Inspect nonstandard assistant_rules YAML before migration")
    path = root / ".storage/core.config_entries"
    storage = json.loads(path.read_text())
    entries = storage["data"]["entries"]
    zero = [entry for entry in entries if entry["domain"] == "assistant_zero"]
    legacy = [entry for entry in entries if entry["domain"] == "assistant_rules"]
    if len(zero) != 1 or len(legacy) > 1:
        raise ValueError("Expected one existing Zero entry and at most one legacy rules entry")
    data = {**load_credentials(root / "assistant_zero_credentials.yaml"), **zero[0]["data"]}
    old = load_credentials(root / "assistant_rules_credentials.yaml")
    if legacy:
        old.update(legacy[0]["data"])
    for key in ("callback_url", "callback_token"):
        if key in data and key in old and data[key] != old[key]:
            raise ValueError("Conflicting callback settings; no migration applied")
        if key not in data and key in old:
            data[key] = old[key]
    if not all(data.get(key) for key in ("url", "token", "satellite_id", "callback_url", "callback_token")):
        raise ValueError("Missing existing Zero or callback connection settings")
    data["settings_token"] = settings_token
    for name in files:
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Invalid component path")
    if not apply:
        return {"zero_entry_id": zero[0]["entry_id"], "legacy_entries": len(legacy)}
    backup = root / "backups" / backup_name
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ("configuration.yaml", "assistant_zero_credentials.yaml", "assistant_rules_credentials.yaml", ".storage/core.config_entries", ".storage/assistant_rules", ".storage/assist_pipeline.pipelines", "custom_components/assistant_zero", "custom_components/assistant_rules"):
        source = root / name
        if source.exists():
            target = backup / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
                target.chmod(0o600)
    component = root / "custom_components/assistant_zero"
    staging = component.with_name(".assistant_zero-next-" + backup_name)
    staging.mkdir(parents=True)
    import base64
    for name, value in files.items():
        target = staging / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(value))
    if component.exists():
        shutil.rmtree(component)
    staging.rename(component)
    zero[0]["data"] = data
    storage["data"]["entries"] = [entry for entry in entries if entry["domain"] != "assistant_rules"]
    temporary = path.with_name(path.name + ".zero-migration")
    temporary.write_text(json.dumps(storage))
    temporary.chmod(0o600)
    temporary.replace(path)
    credentials = root / "assistant_zero_credentials.yaml"
    credentials.write_text(json.dumps(data))
    credentials.chmod(0o600)
    config = "\n".join(line for line in config.splitlines() if not line.startswith("assistant_rules:")) + "\n"
    (root / "configuration.yaml").write_text(config)
    old_component = root / "custom_components/assistant_rules"
    if old_component.exists():
        shutil.rmtree(old_component)
    return {"zero_entry_id": zero[0]["entry_id"], "backup": str(backup), "legacy_entries_removed": len(legacy)}


if __name__ == "__main__":
    import sys
    request = json.load(sys.stdin)
    print(json.dumps(migrate("/config", request["files"], request["settings_token"], request["backup_name"], request.get("apply", True))))
