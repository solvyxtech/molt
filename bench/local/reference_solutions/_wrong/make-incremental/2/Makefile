SRCS := $(sort $(wildcard src/*.md))
OUTS := $(SRCS:src/%.md=out/%.txt)

all: out/all.txt

out/all.txt: $(OUTS)
	cat $(OUTS) > $@
	echo "build $@" >> build.log

out/%.txt: src/%.md common/header.txt
	mkdir -p out
	(cat common/header.txt; tr a-z A-Z < $<) > $@
	echo "build $@" >> build.log

clean:
	rm -rf out

.PHONY: all clean
