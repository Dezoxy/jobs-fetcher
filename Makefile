# The architecture workspace (docs/architecture/). Targets come from
# development-base, as in Flodni, and run locally with Docker. The application's
# own checks stay in package.json (`npm run check`, `npm test`).
# Override any variable per call, e.g. `make view PORT=8081`.

# ── pins ─────────────────────────────────────────────────────────────────────
# The Structurizr image your viewer runs. Keep it identical to Flodni's pin and
# the server's, so the parser here is the parser there.
STRUCTURIZR_IMAGE ?= structurizr/structurizr:2026.10.26

# ── paths ────────────────────────────────────────────────────────────────────
ARCH_DIR ?= docs/architecture
PORT     ?= 8080

STRUCTURIZR := docker run --rm -v "$(CURDIR)/$(ARCH_DIR):/w:ro"

.PHONY: help validate inspect check view viewer-workspace
.DEFAULT_GOAL := help

## help            list the targets
help:
	@awk 'BEGIN { FS = "## " } /^## / { print "  " $$2 }' $(MAKEFILE_LIST)

## validate        parse the workspace with the pinned Structurizr image
validate:
	$(STRUCTURIZR) $(STRUCTURIZR_IMAGE) validate -workspace /w/workspace.dsl

## inspect         list model findings; fails on any ERROR line
inspect:
	@out="$$($(STRUCTURIZR) $(STRUCTURIZR_IMAGE) inspect -workspace /w/workspace.dsl 2>&1)"; \
	printf '%s\n' "$$out"; \
	if printf '%s\n' "$$out" | grep -q 'ERROR'; then echo "inspect: errors found" >&2; exit 1; fi

## check           validate + inspect: run before committing a model change
check: validate inspect

## view            browse the workspace at http://localhost:8080/workspace/1 (PORT=... to change; Ctrl-C stops it)
view:
	docker run --rm -p $(PORT):8080 -v "$(CURDIR)/$(ARCH_DIR):/usr/local/structurizr" $(STRUCTURIZR_IMAGE) local

## viewer-workspace export the workspace as JSON for viewer/ (viewer/public/workspace.json)
viewer-workspace:
	mkdir -p viewer/public
	docker run --rm --user "$$(id -u):$$(id -g)" -v "$(CURDIR)/$(ARCH_DIR):/w:ro" -v "$(CURDIR)/viewer/public:/out" \
		$(STRUCTURIZR_IMAGE) export -workspace /w/workspace.dsl -format json -output /out
