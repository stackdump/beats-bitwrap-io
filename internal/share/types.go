package share

// ContentType registry for the content-addressed store. Today the store
// hosts BeatsShare envelopes at /o/{cid}; BeatsComposition envelopes
// (rendered masters built from one or more BeatsShare ingredients) live
// at /c/{cid}. The Store struct carries a *ContentType so the same
// machinery (CID re-verification, rate limit, dedupe, snapshot) handles
// both — only the URL prefix, on-disk subdir, JSON-Schema, and
// post-decode checks differ per type.

import (
	"bytes"
	_ "embed"
	"fmt"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// ContentType describes one envelope type stored under its own URL prefix.
type ContentType struct {
	// Name is the JSON-LD @type value the envelope MUST declare.
	Name string
	// URLPrefix is the HTTP path prefix this content type is served at,
	// including trailing slash (e.g. "/o/", "/c/").
	URLPrefix string
	// DiskSub is the subdirectory under the store root where envelopes
	// of this type are persisted (e.g. "o", "c"). Used for both new
	// writes (bucketPath) and the startup index walk.
	DiskSub string
	// Schema is the compiled Draft-2020-12 JSON-Schema for this type.
	Schema *jsonschema.Schema
}

//go:embed beats-composition.schema.json
var compositionSchemaBytes []byte

var compiledCompositionSchema = mustCompileCompositionSchema()

func mustCompileCompositionSchema() *jsonschema.Schema {
	c := jsonschema.NewCompiler()
	c.Draft = jsonschema.Draft2020
	const id = "https://beats.bitwrap.io/schema/beats-composition.schema.json"
	if err := c.AddResource(id, bytes.NewReader(compositionSchemaBytes)); err != nil {
		panic(fmt.Sprintf("compile beats-composition schema (add): %v", err))
	}
	s, err := c.Compile(id)
	if err != nil {
		panic(fmt.Sprintf("compile beats-composition schema: %v", err))
	}
	return s
}

// ShareType is the BeatsShare content type — the original /o/{cid} envelopes.
var ShareType = &ContentType{
	Name:      "BeatsShare",
	URLPrefix: "/o/",
	DiskSub:   "o",
	Schema:    compiledShareSchema,
}

// CompositionType is the BeatsComposition content type — masters
// assembled from one or more BeatsShare ingredients, sealed at /c/{cid}.
var CompositionType = &ContentType{
	Name:      "BeatsComposition",
	URLPrefix: "/c/",
	DiskSub:   "c",
	Schema:    compiledCompositionSchema,
}

// LookupContentType returns the registered ContentType with the given
// @type name, or nil if unknown. Lets the snapshot / restore paths
// dispatch on the embedded @type without hardcoding the registry.
func LookupContentType(name string) *ContentType {
	switch name {
	case ShareType.Name:
		return ShareType
	case CompositionType.Name:
		return CompositionType
	}
	return nil
}
