declare const repoKeyBrand: unique symbol;

/**
 * A repository's identity: the file system path of its root. vscode.git hands out a new wrapper
 * object for a repository on every access, so wrappers are never compared.
 */
export type RepoKey = string & { readonly [repoKeyBrand]: true };
