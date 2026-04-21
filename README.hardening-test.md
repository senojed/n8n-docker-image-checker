# Docker Updates - Hardening Test

Tento dokument drzi aktualni stav oddelene hardening test varianty vedle live workflowu.

Aktualni smer projektu je `hardened-only`.
Live `Codex` checker je povazovany za deprecated a nema se dal rozvijet.

## Aktualni faze

Jsme ve `Phase 1 complete-ish + Phase 2.1/2.2/2.3/2.6 wired on hardened host`.

To prakticky znamena:

- test workflowy jsou vygenerovane z repa a nasazene do n8n vedle live sady
- UI webhook, Run webhook i host test script jsou oddelene od live varianty
- probehlo realne overeni mailu, UI, dry-run i ostreho updatu
- test `Run` workflow ted vraci i korektni `400` JSON chyby pro logicky neplatne requesty
- repo ted drzi jen template workflow JSONy bez lokalnich URL, mailu a path tokenu
- append-only audit trail do `/var/log/docker-updates/audit.jsonl` je nasazeny i na test hostu
- hardening checker je pripraveny na schedule + heartbeat do externiho `Healthchecks`
- hardening host script uz ma nasazeny execution lock a pre-check pred `pull`
- hardening `Run` workflow a host script uz umi i `post_check` po realnem updatu
- hardening host script uz pri realnem updatu vytvari compose-level snapshot do `/opt/docker/.backups/`
- hardening `Run` workflow uz ma zapnuty `backupMarkerPath=/opt/docker/.last-backup`
- homelab policy pro `backupMarkerMaxAgeSeconds` je nastavena na `604800` (`7` dni), ne na denni backup cadence

## Nasazena test varianta

Workflowy v n8n:

- `Docker Updates - Checker (Hardening Test)`
- `Docker Updates - UI (Hardening Test)`
- `Docker Updates - Run (Hardening Test)`

Oddeleni od live:

- UI webhook path je lokalni hodnota z `config.local.json`
- Run webhook path je lokalni hodnota z `config.local.json`
- host script path: `/opt/docker/docker-update-apply.phase1.sh`
- checker trigger mode: `schedule` (`30 6 * * *`)

Repo artefakty:

- [config.local.example.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/config.local.example.json:1)
- [service-map.hardening-test.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/service-map.hardening-test.json:1)
- [docker-update-apply.sh](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/docker-update-apply.sh:1) - repo verze s audit append logikou
- [docker-updates-audit.logrotate](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/docker-updates-audit.logrotate:1) - pripraveny host logrotate config
- [workflow-hardening-test-A-checker.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/workflow-hardening-test-A-checker.json:1) - commitnuty template
- [workflow-hardening-test-B-ui.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/workflow-hardening-test-B-ui.json:1) - commitnuty template
- [workflow-hardening-test-C-run.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/workflow-hardening-test-C-run.json:1) - commitnuty template
- lokalni import do n8n se dela z `workflow-hardening-test-*.rendered.json`

## Template vs rendered

Hardening test vetev se ted generuje ve dvou vrstvach:

- repo drzi jen template artefakty bez lokalnich tokenu a URL
- `config.local.json` je gitignored a nese `baseUrl`, `mailTo`, `uiPath`, `runPath`, `sshHost` a dalsi lokalni hodnoty
- `config.local.json` nově nese i `mailFrom` a `smtpCredentialName` pro technicky mailbox pres SMTP
- `checkerHeartbeatUrl` v `config.local.json` je nastaveny na self-hosted `Healthchecks`
- `checkerHeartbeatHeaders` v `config.local.json` doplnuji `Host` header, protoze verejna ping URL je za Authelii a primo by nefungovala
- `operators` z `config.local.json` ted slouzi i pro UI/operator context, token/header auth a audit log
- renderovane soubory `workflow-hardening-test-*.rendered.json` se generuji lokalne a ty se importuji do n8n

Zakladni postup:

```bash
copy config.local.example.json config.local.json
node generate-workflows.mjs --template-only --config service-map.hardening-test.json
node generate-workflows.mjs --config service-map.hardening-test.json
```

## Overeno

Funkcni testy:

- checker funguje
- mailovy odkaz na UI funguje na production webhooku
- UI stranka se korektne vykresli
- dry-run funguje
- realny update funguje
- auto-include pro `immich-server` a `immich-machine-learning` funguje
- po restartu `n8n` kontejneru zustavaji test webhooky funkcni

Validation testy `Run` webhooku:

- prazdne `services` vraci `400 Bad Request`
- nepovolena sluzba vraci `400 Bad Request`
- spatny `Content-Type` vraci `400 Bad Request`
- rozbity JSON vraci `422 Unprocessable Entity` z parseru n8n
- validni dry-run vraci `200 OK`
- validni dry-run po nasazeni `1.4` vraci i `operator` a `workflowExecutionId`
- `1.2` repo-first uz umi vynutit explicitni `operator` a volitelne ho overit trusted hlavickou nebo per-operator tokenem
- validni dry-run po nasazeni `1.4` zapisuje jeden JSONL radek do host `audit.jsonl`
- scheduled hardening checker heartbeatne `Healthchecks` check `n8n-docker-updates-checker` pres interni docker URL + `Host` header
- host dry-run po nasazeni `2.2` porad prochazi
- vynuceny disk fail vraci `phase: precheck_disk`
- vynuceny backup marker fail vraci `phase: precheck_backup`
- health endpointy pro allowlisted sluzby byly overene primo na hostu
- compose-level snapshot pred updatem se zapisuje do `/opt/docker/.backups/<timestamp>/`
- marker `.last-backup` se po realnem updatu aktualizuje automaticky
- zastaraly marker byl overen: dry-run failne na `phase: precheck_backup`
- po obnoveni markeru dry-run znovu prochazi
- realny hardening run vraci i `backupSnapshotDir` a `backupMarkerPath`

Failure-path test:

- byla simulovana kontrolovana chyba pouze v test scriptu `/opt/docker/docker-update-apply.phase1.sh`
- `Run` workflow vratil `ok: false` a smysluplny error payload
- puvodni test script byl po testu obnoven a zkontrolovan `bash -n`

## Co to ted umi

- poslat mail s odkazem na oddelene test UI
- zobrazit pending updaty i u floating tagu, kdy se meni jen digest
- spustit dry-run bez zmen na hostu
- spustit realny update jen pro allowlist sluzeb
- vratit vysledek zpet do UI jako JSON
- poslat vysledkovy mail po realnem updatu
- odmitnout logicky neplatne requesty bez spousteni host skriptu
- byt pripraveny na prechod z Gmail OAuth na `SMTP` credential `ops-smtp`
- chranit host update skript proti soubeznemu behu pres lock file `${COMPOSE_DIR}/.docker-update-apply.lock`
- zastavit update jeste pred `pull`, kdyz je Docker storage nad limitem nebo kdyz je rozbity compose config
- vynutit cerstvy backup marker pres `backupMarkerPath`
- po realnem updatu overit, ze sluzba skutecne nabehla, a pri failu vratit `phase: post_check`
- failure mail po `post_check` failu umi vypsat manual rollback runbook z `prev_digests`
- pri realnem updatu vytvorit compose-level snapshot a drzet retention poslednich `30` behu

## Provozni poznamka k n8n

V n8n neni manualni test z editoru to same jako scheduled beh.

- editorovy manualni beh muze pouzit draft verzi workflowu
- scheduler a production webhooky pouzivaji published verzi
- po zmene node nebo credentials nestaci jen otestovat `Execute workflow`, ale je potreba workflow i publikovat

Prakticky checklist po zmene checkeru:

1. upravit workflow
2. otestovat manualni beh
3. workflow publikovat
4. zkontrolovat, ze zustalo `Active`
5. dalsi automaticky beh overit i rano na realnem schedulu

Tenhle projekt uz na tom realne narazil:

- manualni beh checkeru byl v poradku
- scheduled beh bezel ze starsi published verze
- vysledek byl jiny credential binding nez v editoru

Deploy/publish sanity po zmene workflowu:

- zkontrolovat, ze published verze ma stejne kriticke credentials jako draft
- u scheduler workflowu overit `versionId == activeVersionId`
- po publishi ma workflow zustat `Active`
- u checkeru overit i nejblizsi realny scheduled beh, ne jen manual

## Co jeste neni uzavrene

Tohle neni blocker pro hardening test variantu, ale zustava otevrene:

- live `Docker Updates - Checker (Codex)` ma pri aktivaci chybu `object is not iterable`
- to je deprecated live workflow; doporuceny stav je mit ho vypnuty a dal resit jen hardening sadu
- na test hostu zatim neni nainstalovany balicek `logrotate`, takze rotace je pripravena konfiguracne, ale neoverena behove
- ownership `audit.jsonl` musi zustat na SSH uctu, ktery pouziva n8n `Run` workflow; jinak beh spravne failne ve fazi `audit_log`
- `Healthchecks` check musi mit prirazeny alespon jeden notification channel; bez toho se down stav jen zobrazi v UI, ale nic se neposle
- `1.1` SMTP je repo-first rozpracovane, ale bez realneho `ops-smtp` credentialu a technicke schranky zatim neni nasazene do n8n
- `1.2` auth vrstva je repo-first pripravljena, ale bez doplneni `operatorIdentityHeader` nebo `operators[].token` v lokalnim configu zatim bezi jen allow-list operatoru

## Jak to dal udrzovat

Pri dalsi zmene hardening test varianty aktualizovat:

1. [generate-workflows.mjs](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/generate-workflows.mjs:1)
2. `service-map.hardening-test.json` nebo `config.local.example.json`, pokud se meni shape konfigurace
3. `node generate-workflows.mjs --template-only --config service-map.hardening-test.json`
4. `node generate-workflows.mjs --config service-map.hardening-test.json`
5. tento soubor
6. jen prislusny test workflow v n8n, bez zasahu do live sady

## Posledni dulezite zmeny

- opraven `Build HTML` v test UI workflowu
- doplnena separace test `Run` workflowu proti live scriptu
- opravena validace test `Run` webhooku tak, aby vracela korektni `400` JSON odpovedi
- dodelana separace template vs rendered workflow artefaktu a lokalni konfigurace
- nasazen audit log mimo n8n executions na test host vcetne operator contextu
- opravena code-node quoting chyba v test `Run` workflowu po deployi `1.4`
- aktivovan heartbeat na self-hosted `Healthchecks` pres lokalni config hardening profilu
- doplnen execution lock v host skriptu, aby soubezny druhy beh skoncil na `phase: lock`
- doplnen host pre-check pred `pull`: defaultni disk limit `85 %`, explicitni `phase: precheck_compose` a volitelny backup marker wiring
- doplnen `post_check` wiring: per-service `healthCheck` metadata v `service-map.json`, predani do host skriptu a rollback runbook do result mailu
- doplnen `backup snapshot` wiring: `/opt/docker/.backups/<timestamp>/`, marker `.last-backup` a retention `30`
