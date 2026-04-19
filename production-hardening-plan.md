# Production Hardening Plan

Fázovaná roadmapa pro nasazení `docker-image-checker-n8n` na zákaznický server. Předpoklad: Tailscale ACL je povinná síťová vrstva (webhooky nejsou veřejně dostupné). Pokud zákazník Tailscale mít nebude nebo nebude garantovaně vynucená síťová vrstva, bod 1.2 se rozšiřuje o reverse-proxy auth a stává se plnohodnotným auth blockerem. Původní úvahu viz [production-update.md](production-update.md) — tento dokument ji překlápí do konkrétních změn mapovaných na soubory a nody v repu.

Každý bod má: **Problém**, **Změnit v**, **Konkrétně**, **Hotovo když**.

---

## Fáze 1 — Minimum pro produkci (blocker)

Bez těchto bodů se to k zákazníkovi pustit nemá.

### 1.1 Dedikovaný mail kanál místo osobního Gmail OAuth

**Problém:** Kritická automatizace visí na osobním Gmail OAuth tokenu. Už jednou spadl na `invalid_grant`. U zákazníka to není obhajitelné.

**Stav 2026-04-17:** Repo-first část je hotová. Generátor i workflow JSONy už používají `n8n-nodes-base.emailSend` (`SMTP`) a zbývá jen provozní nasazení technického mailboxu a credentialu `ops-smtp` v n8n.

**Změnit v:**
- [generate-workflows.mjs](generate-workflows.mjs)
- [workflow-A-checker.json](workflow-A-checker.json), node `Send Mail` (typ `n8n-nodes-base.emailSend`)
- [workflow-C-run.json](workflow-C-run.json), node `Send Result Mail` (typ `n8n-nodes-base.emailSend`)

**Konkrétně:** Vyměnit oba Gmail nody za `n8n-nodes-base.emailSend` (SMTP). V n8n založit credential `ops-smtp` s údaji technického mailboxu (např. `ops@customer.tld`). Volby providera: zákazníkův vlastní SMTP relay, Mailgun, Postmark, Resend, Microsoft 365 SMTP — pro plán agnostické, rozhodne se při nasazení.

**Hotovo když:**
- Žádný workflow v repu neobsahuje `n8n-nodes-base.gmail`.
- `ops-smtp` credential existuje, test mail projde z obou workflowů.
- Odesílatel v hlavičce je technický mailbox, ne osobní Gmail.

---

### 1.2 Identita schvalovatele a token hygiene

**Problém:** Tailscale ACL omezuje *kdo se dostane k webhooku*, ale n8n na straně workflow neví, *kdo konkrétně* update schválil. Současné tajné path tokeny v URL jsou statické, sdílené, a navíc jsou commitnuté v `workflow-C-run.json` (viz bod 1.5). Pro audit trail (bod 1.4) je potřeba znát identitu.

**Stav 2026-04-17:** Repo-first část je rozdělená na dvě vrstvy. `operator` je už povinný a generátor umí trusted header (`meta.operatorIdentityHeader`) i per-operator token fallback (`meta.operators[].token`). Nasazení ale ještě vyžaduje doplnit jednu z těchto variant do lokálního configu a přegenerovat rendered workflowy.

**Změnit v:**
- [workflow-B-ui.json](workflow-B-ui.json), HTML generátor — přidat pole `operator`
- [workflow-C-run.json](workflow-C-run.json), node `Webhook Run` a `Validate Selection`

**Konkrétně:**
1. V UI (workflow B) přidat dropdown nebo text input `operator` s předdefinovaným seznamem jmen (konfigurace per host).
2. `Validate Selection` v C odmítne request bez `operator` z allow-listu operátorů.
3. Path token v URL vyměnit za **per-operator token** — každý operátor má svůj, ne sdílený. Token nese n8n credential, ne git repo.
4. Pokud reverse proxy (Caddy / Traefik / Cloudflare Access přes Tailnet) umí dodat hlavičku `Tailscale-User-Login`, přečíst ji v `Validate Selection` a cross-checknout proti `operator`. Bez proxy stačí per-operator token.

**Hotovo když:**
- Webhook bez `operator` v body vrátí 400.
- `operator` je povinná položka zapisovaná do audit logu (1.4).
- V repu není žádný path token — jsou v n8n credentialech nebo v ignored konfiguračním souboru.

---

### 1.3 Strukturovaný error report z host skriptu

**Problém:** [docker-update-apply.sh](docker-update-apply.sh) vrací chyby jako volně formátované `__RESULT__:ERROR:<text>` řetězce. Workflow C je pak jen přepošle. Zákaznický support potřebuje rozlišit typ chyby (auth/SSH, pull, compose up, post-check) strojově, ne regexem.

**Změnit v:**
- [docker-update-apply.sh](docker-update-apply.sh) — výstupní formát
- [workflow-C-run.json](workflow-C-run.json), node `Build Result` — parser

**Konkrétně:**
1. Host skript bude vypisovat poslední řádek jako jeden řádek JSONu, prefixovaný `__RESULT_JSON__:`, se schématem:
   ```json
   {"status":"ok|error","phase":"allowlist|compose_config|pull|up|post_check","services":["..."],"summary":"...","exit_code":0,"prev_digests":{"svc":"sha256:..."},"floating_tag_warning":true}
   ```
2. `phase` je povinná u error stavu. Map: kódy 2–7 → `allowlist|compose_config`, selhání `docker compose pull` → `pull`, selhání `up` → `up`.
3. `Build Result` v C parsuje JSON a předává strukturu dál (do mailu i audit logu). Pokud je služba na floating tagu, nastaví `floating_tag_warning: true` a mail/UI to zobrazí explicitně jako riziko neurčitého diffu.
4. Zachovat zpětně kompatibilní řádek `__RESULT__:OK` i `__RESULT__:ERROR:...` souběžně, dokud se workflow nepřepne — pak starý prefix odstranit.

**Hotovo když:**
- Každá chyba z host skriptu má vyplněnou `phase`.
- Result mail obsahuje sekci „Typ chyby" odvozenou z `phase`, ne z regexu nad stdout.
- Mail a UI explicitně označí služby na floating tagu, i když migrace na pinned tagy ještě neproběhla.
- Suché běhy (`--dry-run`) vrací `{"status":"ok","phase":"dry_run",...}`.

---

### 1.4 Audit log mimo n8n execution historii

**Problém:** Dnes jde všechno dohledat jen v n8n executions. To je ephemeral (retention, restore po failu, export). Zákazník se bude ptát: kdo, kdy, co, předchozí a nový digest, výsledek.

**Změnit v:**
- [workflow-C-run.json](workflow-C-run.json) — nový node za `SSH Apply Update`
- [docker-update-apply.sh](docker-update-apply.sh) — emit `prev_digests` (viz 1.3 a 1.6)

**Konkrétně:** Po úspěšném i neúspěšném běhu appendovat jeden řádek JSON-lines do perzistentního souboru na hostu, typicky `/var/log/docker-updates/audit.jsonl`. Schéma:
```json
{"ts":"2026-04-15T06:32:11Z","operator":"honza","host":"...","services":["nextcloud"],"prev_digests":{"nextcloud":"sha256:..."},"new_digests":{"nextcloud":"sha256:..."},"status":"ok","phase":null,"dry_run":false,"workflow_execution_id":"..."}
```
Zápis dělá host skript (nejjednodušší) pod ownership dedicated usera z bodu 2.5, ne n8n — tím se vyhneme RCE-like vzoru „n8n zapisuje ovládací log". Log je append-only, rotace přes `logrotate` jednou měsíčně s kompresí a minimální retencí 12 měsíců.

**Hotovo když:**
- Každý běh (OK i FAIL, real i dry-run) má právě jeden řádek v `audit.jsonl`.
- `operator`, `prev_digests`, `new_digests` nejsou prázdné u reálných úspěšných běhů.
- Logrotate konfigurace existuje a je otestovaná (`logrotate -d`).

---

### 1.5 Secrets a workflow JSONy v gitu

**Problém:** Workflow JSONy obsahují `webhookId` hodnoty a (po nasazení) path tokeny. Commitnutí do gitu = leak. Stejný problém platí i pro `sendTo`, host nebo jména operátorů, pokud se renderují přímo do commitnutého artefaktu.

**Změnit v:**
- [generate-workflows.mjs](generate-workflows.mjs)
- nový `.gitignore` / README sekce

**Konkrétně:**
1. Generator přijme konfiguraci z lokálního `config.local.json` (gitignored), který obsahuje `operators[]`, `mailTo`, webhook path tokeny, host, SSH cred jméno.
2. Výstupní `workflow-*.json` se rozdělí na **template** (commitnuté, bez secretů, s `__PLACEHOLDER__`) a **rendered** (gitignored, import do n8n).
3. Do `.gitignore`: `workflow-*.rendered.json`, `config.local.json`, `audit.jsonl`.
4. README vysvětlí workflow: `node generate-workflows.mjs` → rendered → import do n8n.

**Hotovo když:**
- `git grep` nenajde v commitnuté verzi žádné jméno operátora, mail, webhook path token ani host.
- `node generate-workflows.mjs` bez `config.local.json` skončí s čitelnou chybou.
- README popisuje, které soubory jsou pro dev, které pro git, které pro n8n.

---

### 1.6 Uložení předchozího digestu před `docker compose pull`

**Problém:** Dnes skript udělá `pull` + `up` a předchozí obraz je pryč, pokud ho nic nedrží. Bez `prev_digests` nelze ani popsat, co se změnilo, ani udělat rollback. Je to jeden z nejlevnějších kroků, který odemyká 1.4 (audit) a 2.3 (rollback).

**Změnit v:**
- [docker-update-apply.sh](docker-update-apply.sh), sekce před `docker compose pull`

**Konkrétně:** Pro každou službu z `services[]` před pullem získat aktuální image ID:
```bash
declare -A prev_digests
for svc in "${services[@]}"; do
  cid="$(docker compose ps -q "$svc" || true)"
  if [[ -n "$cid" ]]; then
    prev_digests["$svc"]="$(docker inspect --format '{{.Image}}' "$cid")"
  fi
done
```
Hodnoty se pak vypíšou do `__RESULT_JSON__` (bod 1.3) a slouží jako vstup pro audit (1.4) i rollback (2.3). Digesty se **netagují** a nemažou — Docker je drží, dokud je nevyčistí `docker image prune`, takže rollback playbook (2.3) musí s tím počítat a prune je zakázán běžet automaticky.

**Hotovo když:**
- `__RESULT_JSON__` obsahuje `prev_digests` pro každou službu, kde běžel container.
- V audit logu (1.4) jsou `prev_digests` a `new_digests` různé u úspěšných reálných updatů.

---

### 1.7 Externí watchdog pro scheduler

**Problém:** Pokud n8n spadne, scheduler neběží, ale nikdo to nezjistí. Watchdog uvnitř stejné n8n instance je k ničemu — je down spolu s ní.

**Změnit v:** infrastruktura hostu, ne repo. [workflow-A-checker.json](workflow-A-checker.json) jen emituje heartbeat.

**Konkrétně:**
1. Na konci workflow A přidat HTTP Request node, který zavolá externí heartbeat URL (healthchecks.io / self-hosted Uptime Kuma / vlastní cron-watcher). Volba providera je agnostická.
2. Heartbeat je nakonfigurovaný na cron `30 6 * * *` s grace period 30 min.
3. Pokud heartbeat nedorazí do 07:00, služba pošle alert na stejný technický mailbox jako bod 1.1.
4. Heartbeat URL držet jen v `config.local.json` jako lokální `meta.checkerHeartbeatUrl`, ne v tracked JSON artefaktech.

**Hotovo když:**
- Zastavení n8n v 06:00 produkuje alert mail do 07:00.
- Heartbeat URL není commitnutá v repo (viz 1.5).

---

## Fáze 2 — Recommended

Tyto body výrazně snižují riziko, ale nejsou blocker pro první produkční nasazení.

### 2.0 Deploy / publish sanity pro n8n workflowy

**Problém:** U n8n nestačí, že funguje ruční test v editoru. Scheduler a production webhooky jedou z published verze. Když se rozjede divergence mezi draftem, `versionId`, `activeVersionId` nebo credential bindingy v publikované verzi, výsledek je zákeřný: manual prochází, automat padá.

**Změnit v:** dokumentace a deploy postup; volitelně později helper skript v `_work/`.

**Konkrétně:**
1. Po každé změně workflow udělat ruční test v editoru.
2. Workflow publikovat.
3. Ověřit, že workflow zůstalo `Active`.
4. Ověřit, že published verze opravdu obsahuje správné credentials na kritických nodech (`Send Mail`, `SSH`, `OpenAI`, případně `Send Result Mail`).
5. Ověřit, že `workflow_entity.versionId == workflow_entity.activeVersionId` u workflowů, které mají běžet po schedulu nebo jako production webhook.
6. U scheduleru udělat ještě jeden real-world check po nejbližším automatickém běhu.

**Hotovo když:**
- po deployi není rozdíl mezi draft a published verzí na kritických nodech
- scheduled checker i production webhooky běží ze stejné verze, kterou jsme právě nasadili
- nevzniká stav „manual OK, scheduled FAIL" způsobený starou published verzí

---

### 2.1 Execution lock

**Problém:** Dva souběžné běhy (manuální + scheduled + retry) by mohly pullnout a nahodit službu dvakrát nebo se prát o compose stav.

**Změnit v:** [docker-update-apply.sh](docker-update-apply.sh)

**Konkrétně:** `flock` na začátku skriptu. Aktuální implementace používá lock file v `${COMPOSE_DIR}/.docker-update-apply.lock`:
```bash
touch "${COMPOSE_DIR}/.docker-update-apply.lock"
exec 9<>"${COMPOSE_DIR}/.docker-update-apply.lock"
flock -n 9 || { echo '__RESULT_JSON__:{"status":"error","phase":"lock","summary":"another update in progress"}'; exit 8; }
```

**Hotovo když:** Souběžné spuštění dvou instancí vrátí druhému volání error `phase=lock`.

---

### 2.2 Pre-check (disk, backup, compose validita)

**Problém:** Update může selhat na plném disku nebo rozbitém compose souboru až po `pull`, kdy už je půlka image stažená.

**Stav 2026-04-19:** Repo-first i hardening host deploy jsou hotové pro `precheck_disk`, `precheck_compose` i marker wiring. Po bodu `2.6` host skript vytváří `.backups/<timestamp>` a aktualizuje `.last-backup`; zapnutí `backupMarkerPath` v n8n configu je pak už jen deploy volba.

**Změnit v:** [docker-update-apply.sh](docker-update-apply.sh), nová sekce před `pull`.

**Konkrétně:**
1. `df` volume backing Dockeru → pokud `Use%` > 85 → fail `phase=precheck_disk`.
2. `docker compose config -q` → pokud nenulový exit → fail `phase=precheck_compose`.
3. Volitelně `stat` na backup marker soubor (`/opt/docker/.last-backup`) mladší než 24 h → jinak `phase=precheck_backup`. Backup marker aktualizuje jiný systém (bod 2.6), tohle je jen kontrola, ne spouštěč backupu.

**Hotovo když:** Pre-check selhání nespustí `pull` a produkuje čitelný error s `phase=precheck_*`.

---

### 2.3 Post-check (health probe, rollback playbook)

**Problém:** Dnes skript končí `docker compose ps` — to jen řekne, že container běží, ne že služba funguje. Bez post-checku není automatický signál pro rollback.

**Stav 2026-04-19:** Repo-first část je hotová a hardening varianta má připravené per-service `healthCheck` metadata i rollback runbook v result mailu. Zbývá prakticky jen end-to-end otestovat reálný `post_check` fail na bezpečně vybraném updatu.

**Změnit v:** [docker-update-apply.sh](docker-update-apply.sh), sekce po `up`. [service-map.json](service-map.json) rozšířit o `healthCheck` per služba.

**Konkrétně:**
1. V `service-map.json` přidat per-službu `healthCheck`: buď `{"type":"docker"}` (čte `docker inspect .State.Health`), nebo `{"type":"http","url":"http://localhost:PORT/health","expectStatus":200}`, nebo `{"type":"none"}`.
2. Skript po `up` 60 s pollem ověří health. Fail → `phase=post_check`, emit `prev_digests` do výsledku.
3. Rollback zůstává **runbookový, ne automatický** — pro první produkční nasazení je bezpečnější člověk, který rozhodne. Runbook je dokumentovaný krok-po-kroku v tomto souboru: `docker tag <prev_digest> <image>:rollback && docker compose up -d --no-deps <svc>`. Předpoklad: `docker image prune` neběží automatizovaně (viz 1.6).

**Hotovo když:**
- Úspěšný update projde post-checkem.
- Simulovaný fail (úmyslně pokažený image) produkuje `phase=post_check` a audit log má oba digesty.
- Runbook rollbacku je v tomto souboru a byl alespoň jednou ručně otestován.

---

### 2.4 Deterministická risk pravidla vedle AI review

**Problém:** AI řekne „safe/caution/manual" — ale u zákazníka nemůže být jediným zdrojem pravdy, protože je nedeterministická a její verdict nejde auditovat.

**Změnit v:** [workflow-A-checker.json](workflow-A-checker.json), node `Enrich Updates` (před `OpenAI AI Review`) a `Build Mail`.

**Konkrétně:** Před AI spustit pravidlový scorer se vstupem z `service-map.json`:
- major version bump (1.x → 2.x) → `manual`
- služba má flag `critical: true` (auth, DB, reverse proxy) → `manual`
- release notes obsahují token „BREAKING", „migration" → `manual`
- pinned patch release (1.2.3 → 1.2.4) → `safe`
- floating tag bez explicitního diffu → `caution` (nikdy `safe`)
AI verdict se pak *nikdy nesmí* zmírnit pravidlový. Mail ukáže oba verdicty vedle sebe.

**Hotovo když:**
- Mail obsahuje u každé služby `rule: ...` i `ai: ...`.
- Služba označená `critical: true` v `service-map.json` má v mailu vždy `rule: manual`, i když AI řekne `safe`.

---

### 2.5 SSH hardening — dedicated user a command restriction

**Problém:** n8n dnes SSH-uje jako `jan` s plným shellem. Blast radius je celý host.

**Změnit v:** konfigurace hostu (mimo repo), ale repo si drží referenční snippet.

**Konkrétně:**
1. Na hostu založit usera `docker-updater`, členství jen ve skupině `docker`.
2. `~/.ssh/authorized_keys` ten klíč omezit:
   ```
   command="/opt/docker/docker-update-apply.sh $SSH_ORIGINAL_COMMAND",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...
   ```
3. `docker-update-apply.sh` už allowlistem argumenty validuje, takže `SSH_ORIGINAL_COMMAND` injection je omezený na allowlisted service names (1.6 bude potřeba re-audit, že žádný argument nejde použít jako shell escape — pozor na mezery a `$()`).
4. V repu nová složka `host/` se šablonami: `host/authorized_keys.example`, `host/docker-updater.service` (pokud by místo SSH vedlo k systemd socketu — opt-in).

**Hotovo když:**
- `ssh docker-updater@host bash` nedá shell, spadne na `command=`.
- `ssh docker-updater@host 'nextcloud; rm -rf /'` neprojde validací v `docker-update-apply.sh`.

---

### 2.6 Backup marker a snapshot před updatem

**Problém:** Pre-check (2.2) kontroluje existenci backup markeru, ale nikdo ho nevytváří. Pro minimální produkční rozumnost potřebujeme alespoň snapshot compose souboru a current digestů těsně před updatem.

**Stav 2026-04-19:** Repo-first i hardening host deploy jsou hotové. Host skript před `pull` vytváří `/opt/docker/.backups/<timestamp>/`, zapisuje `prev_digests.json`, `metadata.json`, `docker-compose.rendered.yml`, aktualizuje `.last-backup` a drží retention posledních `30` běhů.

**Změnit v:** [docker-update-apply.sh](docker-update-apply.sh), nová sekce po pre-check, před `pull`.

**Konkrétně:**
1. Vytvořit `/opt/docker/.backups/<timestamp>/` a zkopírovat tam `docker-compose.yml` + výstup `docker compose config` + `prev_digests` jako JSON.
2. Aktualizovat `/opt/docker/.last-backup` (konzumuje 2.2).
3. Retention: posledních 30 běhů, starší smazat.
4. Plnohodnotný volume snapshot (btrfs/ZFS/LVM) je mimo rozsah — tohle je „compose-level backup", stačí na rollback konfigurace, ne stavu.

**Hotovo když:**
- Každý reálný běh vytvoří adresář s kopií compose a digestů.
- Retention drží právě 30 adresářů.

---

## Fáze 3 — Nice to have

Tyto body odlišují „slušně provozované" od „sofistikovaně provozované". Ne blocker.

### 3.1 Přechod na pinned tagy a release-driven flow

**Problém:** Floating tagy (`latest`, `release`) znamenají, že dnešní „update" může zítra znamenat něco jiného. Pro zákaznický audit je to slabé.

**Změnit v:** [service-map.json](service-map.json), compose soubor na hostu, [generate-workflows.mjs](generate-workflows.mjs).

**Konkrétně:** Je to **datová migrace**, ne workflow úprava. Dva podkroky, kdykoliv odděleně:
1. Migrace compose: pro každou službu z `allowed-services.txt` zjistit aktuální reálný tag a zapsat ho do compose natvrdo (`image: foo/bar:1.35.4`). Toto je ruční diff-review krok, nelze automatizovat bez rizika.
2. Upravit checker workflow: místo „je jiný digest?" se ptá „je novější semver tag?" (přes registry API nebo Renovate). Update návrh pak obsahuje konkrétní `1.35.4 → 1.35.6` s release notes diffem, ne jen „latest se pohnul".

**Hotovo když:**
- V `allowed-services.txt` není žádná služba s floating tagem na hostu (kontrola: `docker compose config | grep -E ':(latest|release|stable)'` je prázdné).
- Update návrh v mailu obsahuje `from → to` konkrétní verze, ne jen „new digest".

---

### 3.2 Multi-customer config layout

**Problém:** Dnes je všechno pro jeden host. Druhý zákazník znamená fork.

**Změnit v:** struktura repa.

**Konkrétně:** Rozložit na:
```
engine/               # generator, host skript, helper — sdílené
customers/<name>/
  service-map.json
  allowed-services.txt
  host-policy.json    # SSH target, operators, mail recipients
  config.local.json   # secrets (gitignored)
```
`generate-workflows.mjs` přijímá `--customer=<name>` a renderuje workflowy do `customers/<name>/rendered/`.

**Hotovo když:**
- `node generate-workflows.mjs --customer=demo` vyrobí kompletní sadu workflowů bez úprav enginu.
- Druhý zákazník vznikne přidáním adresáře `customers/<name>/`, ne forkem repa.

---

### 3.3 Metriky úspěšnosti updatů

**Problém:** Bez metrik nejde říct „updatujeme spolehlivě" — jen „tento týden to nespadlo".

**Změnit v:** konzument audit logu z 1.4.

**Konkrétně:** Malý skript / Grafana dashboard nad `audit.jsonl`:
- počet úspěšných vs. neúspěšných updatů / týden
- rozložení `phase` u chyb
- medián doby mezi `release published` a `update applied` per služba
Provider agnostický — může to být Loki+Grafana, může to být jednorázový Python skript spouštěný měsíčně.

**Hotovo když:** Existuje jeden report, který odpovídá na „kolik updatů za měsíc selhalo a na čem".

---

## Co se nesmí commitnout

Shrnutí bodu 1.5 jako kontrolní seznam. Cokoliv z toho v `git ls-files` = blocker pro release.

- Webhook path tokeny (UI i Run).
- Per-operator tokeny.
- Jména a maily operátorů.
- `sendTo` adresy.
- SSH private key, hostkey, known_hosts s produkcí.
- `audit.jsonl`.
- `*.rendered.json` (generované workflowy).
- `config.local.json`.

---

## Pořadí práce

1. Fáze 1 bez externích vstupů: **1.6 → 1.3 → 1.5 → 1.4 → 1.7**.
2. `1.6` je první, protože odemyká `1.3` a `1.4`.
3. `1.5` je před `1.4`, aby další workflow změny už vznikaly nad splitnutým template/rendered modelem a ne nad dočasným stavem.
4. `1.7` je technicky nezávislý, ale v repu dává smysl až po `1.5`, protože heartbeat URL spadá do stejné secrets hygiene vrstvy jako ostatní neveřejná konfigurace.
5. Pak pauza na zákaznické vstupy: `1.1` (SMTP/provider) a `1.2` (operátoři, token hygiene, případně reverse-proxy auth).
6. Fáze 2 držet jako changesety, ne jako plochý seznam: **2.1 → (2.2 + 2.3 + 2.6) → 2.4 → 2.5**.
7. Fáze 3 až po prvním reálném nasazení, kdy bude zpětná vazba z provozu.

## Verifikace plánu jako celku

- Každý bod má Problém / Změnit v / Konkrétně / Hotovo když — ✓ kontrola čtením.
- Každé „Změnit v" odkazuje na existující soubor — ✓ ověřeno proti repu při psaní.
- Fáze 1 neobsahuje nic, bez čeho by to k zákazníkovi šlo pustit, a naopak — ✓ mail, auth identita, audit, error report, secrets, digest tracking, externí watchdog.
- Žádný bod neřeší víc než jednu věc — ✓ všechny jsou cut-podle-changeset, ne podle tématu.
