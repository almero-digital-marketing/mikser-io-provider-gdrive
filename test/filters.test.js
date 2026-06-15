// Pure-logic tests for include/exclude filter semantics.
// No Drive client, no engine — just minimatch under our own rules.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { passesFilters } from '../lib/sync.js'

describe('passesFilters', () => {
    describe('defaults — operator-noise excluded', () => {
        it('drops .DS_Store at any depth', () => {
            assert.equal(passesFilters('.DS_Store', {}), false)
            assert.equal(passesFilters('subfolder/.DS_Store', {}), false)
            assert.equal(passesFilters('deep/path/.DS_Store', {}), false)
        })

        it('drops Office lockfiles (.~lock.*)', () => {
            assert.equal(passesFilters('.~lock.proposal.docx#', {}), false)
        })

        it('drops Office temp files (~$*)', () => {
            assert.equal(passesFilters('~$report.xlsx', {}), false)
        })

        it('drops Thumbs.db / desktop.ini', () => {
            assert.equal(passesFilters('Thumbs.db', {}), false)
            assert.equal(passesFilters('drafts/desktop.ini', {}), false)
        })

        it('leaves ordinary paths alone', () => {
            assert.equal(passesFilters('welcome.gdoc', {}), true)
            assert.equal(passesFilters('subfolder/notes.md', {}), true)
        })
    })

    describe('include — only matched paths pass', () => {
        it('only allows extensions in include list', () => {
            const opts = { include: ['**/*.md', '**/*.gdoc'] }
            assert.equal(passesFilters('welcome.md', opts), true)
            assert.equal(passesFilters('proposal.gdoc', opts), true)
            assert.equal(passesFilters('photo.png', opts), false)
            assert.equal(passesFilters('subfolder/notes.md', opts), true)
        })

        it('empty include means "everything" (still subject to excludes)', () => {
            assert.equal(passesFilters('anything.txt', { include: [] }), true)
        })
    })

    describe('exclude — explicit subtrees dropped', () => {
        it('drops _archive subfolder', () => {
            const opts = { exclude: ['_archive/**'] }
            assert.equal(passesFilters('_archive/old.gdoc', opts), false)
            assert.equal(passesFilters('_archive/2024/q3.gdoc', opts), false)
            assert.equal(passesFilters('welcome.gdoc', opts), true)
        })

        it('drops _drafts at any depth', () => {
            const opts = { exclude: ['**/_drafts/**'] }
            assert.equal(passesFilters('_drafts/scratch.gdoc', opts), false)
            assert.equal(passesFilters('subfolder/_drafts/scratch.gdoc', opts), false)
            assert.equal(passesFilters('subfolder/notes.gdoc', opts), true)
        })
    })

    describe('include + exclude composed', () => {
        it('exclude beats include when both match', () => {
            const opts = {
                include: ['**/*.md'],
                exclude: ['_archive/**'],
            }
            assert.equal(passesFilters('welcome.md', opts), true)
            assert.equal(passesFilters('_archive/old.md', opts), false)
        })
    })

    describe('defaults always stack on top of user excludes', () => {
        it('user-supplied excludes do not displace the defaults', () => {
            const opts = { exclude: ['_archive/**'] }
            assert.equal(passesFilters('.DS_Store', opts), false)
            assert.equal(passesFilters('subfolder/.DS_Store', opts), false)
        })
    })
})
