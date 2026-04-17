# Docker Updates - Hardening Test

Tento dokument drzi aktualni stav oddelene hardening test varianty vedle live workflowu.

Aktualni smer projektu je `hardened-only`.
Live `Codex` checker je povazovany za deprecated a nema se dal rozvijet.

## Aktualni faze

Jsme ve `Phase 1 / functional verification + secrets hygiene + audit trail deployed + watchdog live`.

To prakticky znamena:

- test workflowy jsou vygenerovane z repa a nasazene do n8n vedle live sady
- UI webhook, Run webhook i host test script jsou oddelene od live varianty
- probehlo realne overeni mailu, UI, dry-run i ostreho updatu
- test `Run` workflow ted vraci i korektni `400` JSON chyby pro logicky neplatne requesty
- repo ted drzi jen template workflow JSONy bez lokalnich URL, mailu a path tokenu
- append-only audit trail do `/var/log/docker-updates/audit.jsonl` je nasazeny i na test hostu
- hardening checker je pripraveny na schedule + heartbeat do externiho `Healthchecks`

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
- `checkerHeartbeatUrl` v `config.local.json` je nastaveny na self-hosted `Healthchecks`
- `checkerHeartbeatHeaders` v `config.local.json` doplnuji `Host` header, protoze verejna ping URL je za Authelii a primo by nefungovala
- `operators` z `config.local.json` ted slouzi i pro UI/operator context a audit log
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
- validni dry-run po nasazeni `1.4` zapisuje jeden JSONL radek do host `audit.jsonl`
- scheduled hardening checker heartbeatne `Healthchecks` check `n8n-docker-updates-checker` pres interni docker URL + `Host` header

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

## Co jeste neni uzavrene

Tohle neni blocker pro hardening test variantu, ale zustava otevrene:

- live `Docker Updates - Checker (Codex)` ma pri aktivaci chybu `object is not iterable`
- to je deprecated live workflow; doporuceny stav je mit ho vypnuty a dal resit jen hardening sadu
- na test hostu zatim neni nainstalovany balicek `logrotate`, takze rotace je pripravena konfiguracne, ale neoverena behove
- ownership `audit.jsonl` musi zustat na SSH uctu, ktery pouziva n8n `Run` workflow; jinak beh spravne failne ve fazi `audit_log`
- `Healthchecks` check musi mit prirazeny alespon jeden notification channel; bez toho se down stav jen zobrazi v UI, ale nic se neposle

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
