# Nasazeni Docker update automatizace pro Homeassistant server

## Summary

- Existujici n8n na dataserveru zustane centralni "mozek" automatizace.
- Dataserver a Homeassistant budou mit samostatne trojice workflowu.
- Soucasna sada `Hardening Test` se pouze prejmenuje na `Dataserver`, bez zmeny funkce.
- Homeassistant dostane novou sadu workflowu cilenou na `jan@<homeassistant-ip>`.

## Key Changes

- Prejmenovat stavajici dataserver workflowy:
  - `Docker Updates - Checker (Hardening Test)` -> `Docker Updates - Checker (Dataserver)`
  - `Docker Updates - UI (Hardening Test)` -> `Docker Updates - UI (Dataserver)`
  - `Docker Updates - Run (Hardening Test)` -> `Docker Updates - Run (Dataserver)`
- Rozsirit `docker-update-apply.sh` zpetne kompatibilne:
  - default bez parametru dal pouziva dataserver `/opt/docker`
  - novy HA beh pouzije `--compose-file /opt/docker-compose.yaml`
- Pridat HA profil, napr. `service-map.homeassistant.json`, se samostatnymi workflow nazvy, webhook path tokeny, SSH cilem `<homeassistant-ip>` a host cestami pod `/opt/docker-updates`.
- Sluzby pro HA profil odvodit z realneho `docker compose -f /opt/docker-compose.yaml config`, ne z rucniho seznamu.
- Kriticke HA sluzby jako Home Assistant, InfluxDB a Node-RED oznacit konzervativne a nepredvybirat je v UI.

## Deployment Flow

- Read-only SSH kontrola HA serveru:
  - overit `jan@<homeassistant-ip>`
  - precist compose services a image refs z `/opt/docker-compose.yaml`
  - overit dostupnost Docker Compose
- Pripravit HA service mapu a allowlist podle realneho compose.
- Vygenerovat template i rendered workflowy pro HA profil.
- Nasadit na HA server:
  - `/opt/docker-updates/docker-update-apply.sh`
  - `/opt/docker-updates/docker-image-version-info.py`
  - `/opt/docker-updates/allowed-services.txt`
  - `/var/log/docker-updates/audit.jsonl`
- Importovat nove HA workflowy do existujiciho n8n.
- Prejmenovat stavajici dataserver workflowy na `Dataserver` a zkontrolovat, ze zustaly aktivni.

## Test Plan

- Lokalni overeni:
  - overit generovani dataserver profilu bez funkcni zmeny
  - overit generovani HA profilu
  - zkontrolovat rendered workflowy na spravne nazvy, webhook paths a `sshHost`
- Na HA serveru:
  - `bash -n` update skriptu
  - dry-run jedne nizkorizikove sluzby
  - audit append do `/var/log/docker-updates/audit.jsonl`
- V n8n:
  - rucne spustit HA checker
  - otevrit HA UI webhook
  - spustit HA dry-run z UI
  - overit, ze dataserver workflowy po rename porad zustaly `Active`

## Assumptions

- SSH user je `jan` a key auth na `<homeassistant-ip>` funguje.
- n8n zustava na dataserveru.
- Homeassistant compose file je `/opt/docker-compose.yaml`.
- Dataserver workflow logika se nemeni; meni se jen jejich zobrazovany nazev.
- Prvni ostry update na HA serveru se udela jen pro nizkorizikovou sluzbu po uspesnem dry-runu.

## Rollout status 2026-05-03

- HA server overen pres SSH jako `jan@<homeassistant-ip>`, hostname `linux-server`.
- Compose file `/opt/docker-compose.yaml` existuje a obsahuje 13 sluzeb.
- Host artefakty jsou nasazene na HA serveru v `/opt/docker-updates`.
- Audit log je pripraveny v `/var/log/docker-updates/audit.jsonl`.
- n8n credential `SSH Private Key Homeassistant` byl vytvoren pro HA server.
- n8n workflowy byly vytvorene a aktivovane:
  - `Docker Updates - Checker (Homeassistant)`
  - `Docker Updates - UI (Homeassistant)`
  - `Docker Updates - Run (Homeassistant)`
- Puvodni `Hardening Test` workflowy byly prejmenovane na `Dataserver`.
- Overeno:
  - primy host dry-run pro `diun`
  - produkcni n8n Run webhook dry-run pro `diun`
  - produkcni n8n UI webhook s operator tokenem
  - UI bez operator tokenu spravne odmita pristup
- Odkaz z HA mailu byl upraven na verejnou HTTPS URL bez operator tokenu v query stringu. UI pro jedineho operatora token vlozi server-side do formulare pro Run endpoint.
- HA `backupMarkerPath` je v lokalnim rendered configu docasne prazdny, aby prvni dry-run nepadal na chybejicim markeru. Po prvnim ostrem updatu a vytvoreni snapshot markeru lze zapnout `/opt/.last-backup`.
