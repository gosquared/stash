RUNNER ?= ./node_modules/mocha/bin/mocha
REPORTER ?= list

run = $(RUNNER) -R $(REPORTER) $(2) $(1)

coverage:
	./node_modules/istanbul/lib/cli.js cover ./node_modules/mocha/bin/_mocha -- --ui bdd -R spec -t 5000
	open coverage/lcov-report/index.html

test:
	$(call run,./test/stash.js)

.PHONY: test coverage
