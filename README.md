# Docker Updates - Codex Variant

Tahle slozka obsahuje oddelenou, bezpecnejsi variantu Docker update automatizace pro n8n. Puvodni Claude Code rozpracovani zustava vedle jako reference a neni timhle dotcene.

Aktualni stav hardening test varianty je prubezne vedeny v [README.hardening-test.md](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/README.hardening-test.md:1).
Aktualni smer projektu je `hardened-only`; puvodni live `Codex` workflowy jsou uz jen legacy reference.

## Co tato varianta dela

1. Jednou denne v `06:30` pres `SSH` zkontroluje whitelistovane sluzby proti remote image stavu.
2. Pokud najde skutecne zastaralou sluzbu, pripravi mail se seznamem a AI komentarem.
3. Odkaz v mailu otevira HTML stranku s checkboxy.
4. Stranka umi jak realny update, tak `dry-run bez zmen` pro bezpecne otestovani flow.
5. Pred spustenim zobrazi best-effort `Aktualne` a `Cil` verzi z Docker image metadata, kdyz je image publikuje.
6. Po potvrzeni se update spousti pres host skript na serveru, ne pres libovolny shell z webu.
7. Po dokonceni prijde vysledek zpet do UI a po realnem updatu i mailem.

## Proc je to bezpecnejsi

- n8n nepousti `docker compose` primo z verejneho webhooku.
- Update muze spustit jen allowlist sluzeb z `allowed-services.txt`.
- `Dry-run` overi vyber, allowlist a pritomnost sluzeb v compose bez `pull/up`.
- `Dry-run` neposila mail, vysledek vraci jen do UI.
- Realny update posle vysledkovy mail jak pro `OK`, tak pro `FAIL`.
- UI i Run endpoint maji tajny path token v URL.
- Workflow neni zavisly na Diun log historii ani na tom, jestli se update zrovna ten den zalogoval.

## Co je v teto slozce

- `plan.md` - lidsky plan a shrnuti.
- `README.hardening-test.md` - aktualni stav, overeni a otevrene body pro oddelenou hardening test variantu.
- `service-map.json` - zdroj pravdy pro image -> service mapu a metadata sluzeb.
- `service-map.hardening-test.json` - overlay config pro oddelenou test variantu vedle live workflowu.
- `config.local.example.json` - sablona pro lokalni neveřejnou konfiguraci.
- `generate-workflows.mjs` - generator workflow JSONu.
- `workflow-A-checker.json` - commitnuty template checker workflowu.
- `workflow-B-ui.json` - commitnuty template UI workflowu.
- `workflow-C-run.json` - commitnuty template run workflowu.
- `workflow-hardening-test-A-checker.json` - commitnuty template checker workflowu pro hardening test.
- `workflow-hardening-test-B-ui.json` - commitnuty template UI workflowu pro hardening test.
- `workflow-hardening-test-C-run.json` - commitnuty template run workflowu pro hardening test.
- `allowed-services.txt` - allowlist pro host skript.
- `allowed-services.hardening-test.txt` - stejne data pro test variantu, vygenerovane separatne.
- `docker-update-apply.sh` - host skript, ktery opravdu spousti update.
- `docker-updates-audit.logrotate` - pripraveny `logrotate` config pro `/var/log/docker-updates/audit.jsonl`.
- `docker-image-version-info.py` - host helper pro current/target verzi a digest bez realneho updatu.

## Template vs rendered

Repo od bodu `1.5` drzi jen bezpecne template workflowy bez lokalnich tokenu a adres.

- commitnute `workflow-*.json` jsou template artefakty s placeholdery
- lokalni `workflow-*.rendered.json` se generuji z `config.local.json`
- `config.local.json` je gitignored a drzi lokalni hodnoty jako:
  - `baseUrl`
  - `mailTo`
  - `checkerHeartbeatUrl`
  - `uiPath`
  - `runPath`
  - `operators`
  - `sshCredentialName`
  - `sshHost`
- `service-map.json` drzi bezpecne sdilena runtime metadata jako `auditLogPath`

Zakladni workflow:

```bash
copy config.local.example.json config.local.json
```

Pak:

```bash
node generate-workflows.mjs --template-only
node generate-workflows.mjs
node generate-workflows.mjs --template-only --config service-map.hardening-test.json
node generate-workflows.mjs --config service-map.hardening-test.json
```

Bez `config.local.json` generator pro rendered vystup skonci chybou. To je zamer.

## Co bude potreba v n8n

- `Gmail` credential - uz mas.
- `OpenAI` credential - uz mas.
- `SSH` credential - to pak nastavime spolu.

Do n8n se maji importovat renderovane soubory `workflow-*.rendered.json`, ne template `workflow-*.json`.

## Live vs hardening test

Legacy live workflowy:

- `Docker Updates - Checker (Codex)`
- `Docker Updates - UI (Codex)`
- `Docker Updates - Run (Codex)`

Vedle nich je pripravena oddelena test varianta:

- `Docker Updates - Checker (Hardening Test)`
- `Docker Updates - UI (Hardening Test)`
- `Docker Updates - Run (Hardening Test)`

Oddeleni test varianty:

- UI webhook path je oddeleny a bere se z `config.local.json`
- Run webhook path je oddeleny a bere se z `config.local.json`
- host script path: `/opt/docker/docker-update-apply.phase1.sh`
- checker bezi na schedulu `30 6 * * *`

Generovani test artefaktu:

```bash
node generate-workflows.mjs --template-only --config service-map.hardening-test.json
node generate-workflows.mjs --config service-map.hardening-test.json
```

## SSH credential do n8n

Doporucene nastaveni credentialu v n8n:

- credential name: lokalni hodnota z `config.local.json`
- host: lokalni hodnota z `config.local.json`
- port: `22`
- user: lokalni SSH user podle hostu
- authentication method: `Private Key` je bezpecnejsi, `Password` je jednodussi pokud uz ho mas po ruce

## Dulezite chovani

- Canonical URL se bere z `config.local.json` (`meta.baseUrl`).
- HTML stranka pouziva absolutni URL, ne relativni, aby fungovala i v novejsim n8n sandboxu.
- AI review je doporuceni, ne matematicka garance. Krome AI se pouziva i konzervativni baseline podle typu sluzby.
- `Run` workflow predava host skriptu `operator`, `workflowExecutionId` a `auditLogPath`.
- Scheduler checker umi na konci workflow poslat watchdog heartbeat na `meta.checkerHeartbeatUrl`, ale jen kdyz je lokalne nastaveny a checker bezi v schedule modu.
- Dokud neni hotovy bod `1.1`, UI bez explicitni volby operatora pouzije prvni hodnotu z `config.local.json`.
- Host skript appenduje audit do `meta.auditLogPath`, defaultne `/var/log/docker-updates/audit.jsonl`.
- Audit soubor i adresar musi byt zapisovatelne pro SSH ucet z n8n credentialu, jinak `Run` skonci chybou s `phase: audit_log`.

## Externi watchdog

Pro `1.7` se heartbeat nastaveni drzi jen v `config.local.json`:

```json
{
  "defaults": {
    "meta": {
      "checkerHeartbeatUrl": "https://healthchecks.example/ping/...",
      "checkerHeartbeatHeaders": {
        "Host": "healthchecks.example"
      }
    }
  }
}
```

- heartbeat node se vyrenderuje jen pro scheduled checker
- pro hardening profil je mozne drzet samostatny `checkerHeartbeatUrl`, takze zmena watchdog sluzby je jen v lokalnim configu
- `checkerHeartbeatHeaders` jsou volitelne; hodi se pro self-hosted watchdog za reverzni proxy nebo auth vrstvou
- na tomhle hostu je verejna `Healthchecks` ping URL za Authelii, takze funkcni varianta je interni docker URL + `Host` header
- externi sluzbu nastav na cron `30 6 * * *` a grace period `30 min`

## Nasazeni na host

Host je v tomhle kroku uz pripraveny:

- `/opt/docker/docker-update-apply.sh`
- `/opt/docker/docker-image-version-info.py`
- `/opt/docker/allowed-services.txt`
- `/var/log/docker-updates/audit.jsonl`

Na serveru je nastaveno:

```bash
chmod +x /opt/docker/docker-update-apply.sh
```

Pro audit trail navic priprav:

```bash
install -d /var/log/docker-updates
touch /var/log/docker-updates/audit.jsonl
chown <ssh-user>:<ssh-group> /var/log/docker-updates /var/log/docker-updates/audit.jsonl
chmod 755 /var/log/docker-updates
chmod 664 /var/log/docker-updates/audit.jsonl
cp docker-updates-audit.logrotate /etc/logrotate.d/docker-updates-audit
logrotate -d /etc/logrotate.d/docker-updates-audit
```

Dalsi kroky:

1. Vytvor a vypln `config.local.json`.
2. Vygeneruj `workflow-*.rendered.json`.
3. Zkopiruj aktualni `docker-update-apply.sh` na host, pokud ma pouzivat audit log a nove argumenty `--operator` / `--workflow-execution-id`.
4. V n8n vytvor odpovidajici credentialy.
5. V n8n importuj renderovane workflow JSONy.
6. Doplni se `SSH` credential do node `SSH`.
7. Doplni se `OpenAI` credential do node `OpenAI AI Review`.
8. Doplni se `Gmail` credential do Gmail nodu.
9. Workflowy se publikujou.

## Poznamka k AI review

AI dostava metadata sluzeb, release URL a baseline risk. Proto umi dat rozumne doporuceni typu:

- `Bezpecne`
- `Pozor`
- `Rucni kontrola`

U sluzeb s floating tagy jako `latest` nebo `release` bude AI casto konzervativnejsi, protoze bez explicitniho diffu nelze zarucit presny rozsah zmen.
