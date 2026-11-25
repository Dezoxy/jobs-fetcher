// This repository's styles. The shared meanings (people, systems, external,
// shapes, security markings, arrows) and the approved palette come from
// styles-shared.dsl, copied unchanged from development-base. This file only maps
// this system's layers onto palette families.
// Tag order matters on an element: layer tag first, security marking last.

styles {
    !include styles-shared.dsl

    // Layers: Edge purple (the Worker and the UI on Cloudflare), Runtime green
    // (the Azure jobs), Data slate (D1, KV, Key Vault, backup storage).
    element "Layer Edge" {
        background ${PURPLE_FILL}
        stroke ${PURPLE_STROKE}
    }
    relationship "Layer Edge" {
        color ${PURPLE_STROKE}
    }
    element "Layer Runtime" {
        background ${GREEN_FILL}
        stroke ${GREEN_STROKE}
    }
    relationship "Layer Runtime" {
        color ${GREEN_STROKE}
    }
    element "Layer Data" {
        background ${SLATE_FILL}
        stroke ${SLATE_STROKE}
    }
    relationship "Layer Data" {
        color ${SLATE_STROKE}
    }
}
