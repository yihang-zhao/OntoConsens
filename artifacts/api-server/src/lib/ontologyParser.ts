import { Parser as TurtleParser } from "n3";
import { RdfXmlParser } from "rdfxml-streaming-parser";
import { Readable } from "node:stream";

export interface ParsedClass {
  uri: string;
  label: string;
}

export interface ParsedRelation {
  childUri: string;
  parentUri: string;
}

export interface ParsedOntology {
  classes: ParsedClass[];
  relations: ParsedRelation[];
}

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";

interface Quad {
  subject: { value: string; termType: string };
  predicate: { value: string };
  object: { value: string; termType: string };
}

function labelFromUri(uri: string): string {
  const hashIndex = uri.lastIndexOf("#");
  const slashIndex = uri.lastIndexOf("/");
  const cut = Math.max(hashIndex, slashIndex);
  const local = cut >= 0 ? uri.slice(cut + 1) : uri;
  return local.replace(/[_-]+/g, " ").trim() || uri;
}

function extractFromQuads(quads: Quad[]): ParsedOntology {
  const classUris = new Set<string>();
  const labels = new Map<string, string>();
  const relations: ParsedRelation[] = [];

  for (const quad of quads) {
    if (
      quad.predicate.value === RDF_TYPE &&
      (quad.object.value === OWL_CLASS || quad.object.value === RDFS_CLASS) &&
      quad.subject.termType !== "BlankNode"
    ) {
      classUris.add(quad.subject.value);
    }
  }

  for (const quad of quads) {
    if (
      quad.predicate.value === RDFS_LABEL &&
      classUris.has(quad.subject.value)
    ) {
      labels.set(quad.subject.value, quad.object.value);
    }
  }

  for (const quad of quads) {
    if (
      quad.predicate.value === RDFS_SUBCLASS_OF &&
      quad.subject.termType !== "BlankNode" &&
      quad.object.termType !== "BlankNode" &&
      classUris.has(quad.subject.value) &&
      classUris.has(quad.object.value)
    ) {
      relations.push({
        childUri: quad.subject.value,
        parentUri: quad.object.value,
      });
    }
  }

  const classes: ParsedClass[] = Array.from(classUris).map((uri) => ({
    uri,
    label: labels.get(uri) ?? labelFromUri(uri),
  }));

  return { classes, relations };
}

function parseTurtle(content: string): Promise<ParsedOntology> {
  return new Promise((resolve, reject) => {
    const parser = new TurtleParser({ format: "text/turtle" });
    const quads: Quad[] = [];
    parser.parse(content, (error: Error | null, quad: Quad | null) => {
      if (error) {
        reject(error);
        return;
      }
      if (quad) {
        quads.push(quad);
      } else {
        resolve(extractFromQuads(quads));
      }
    });
  });
}

function parseRdfXml(content: string): Promise<ParsedOntology> {
  return new Promise((resolve, reject) => {
    const parser = new RdfXmlParser();
    const quads: Quad[] = [];
    parser.on("data", (quad: Quad) => quads.push(quad));
    parser.on("error", reject);
    parser.on("end", () => resolve(extractFromQuads(quads)));
    Readable.from([content]).pipe(parser);
  });
}

export async function parseOntologyFile(
  filename: string,
  content: string,
): Promise<ParsedOntology> {
  const lower = filename.toLowerCase();
  const looksLikeXml = content.trimStart().startsWith("<");

  if (
    lower.endsWith(".rdf") ||
    lower.endsWith(".owl") ||
    lower.endsWith(".xml") ||
    looksLikeXml
  ) {
    return parseRdfXml(content);
  }

  return parseTurtle(content);
}
